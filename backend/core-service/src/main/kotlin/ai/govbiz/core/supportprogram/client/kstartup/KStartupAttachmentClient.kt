package ai.govbiz.core.supportprogram.client.kstartup

import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import org.jsoup.Jsoup
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** K-Startup API가 제공한 공식 상세 URL에서 직접 연결된 신청 첨부를 수집합니다. */
@Component
class KStartupAttachmentClient(
    @param:Qualifier("kStartupSourceDocumentRestClient") private val restClient: RestClient,
) {
    fun collect(sourceCode: String, sourceProgramId: String, sourceUrl: String): SupportProgramAttachments {
        if (sourceCode != "KSTARTUP" || !PROGRAM_ID.matches(sourceProgramId)) fail(Reason.UNSUPPORTED)
        return try {
            val requested = requireDetailUri(URI(sourceUrl), sourceProgramId)
            var html = fetchPage(requested)
            var detailUri = requested
            REDIRECT.find(html)?.groupValues?.get(1)?.let { path ->
                val redirected = requireDetailUri(requested.resolve(path.replace("&amp;", "&")), sourceProgramId)
                if (redirected == requested) fail(Reason.INVALID)
                detailUri = redirected
                html = fetchPage(redirected)
            }
            if (REDIRECT.containsMatchIn(html)) fail(Reason.INVALID)
            val page = Jsoup.parse(html, detailUri.toString())
            val title = page.selectFirst("#scrTitle h3")?.text()?.trim().orEmpty()
            if (title.isBlank()) fail(Reason.NOT_FOUND)
            val warnings = mutableListOf("K-Startup 공식 페이지가 직접 연결한 PDF/HWP/HWPX만 수집했습니다. 추출 결과는 사용자가 원문과 대조해야 합니다.")
            val candidates = linkedMapOf<String, Candidate>()
            page.select(".board_file li").forEach { item ->
                val fileName = item.selectFirst("a.file_bg")?.text()?.trim().orEmpty()
                if (fileName.isBlank()) return@forEach
                val format = format(fileName)
                if (format == null) {
                    warnings.add("미수집 첨부(지원 형식 PDF/HWP/HWPX 이외): ${fileName.take(250)}")
                    return@forEach
                }
                val links = item.select("a.btn_down[name=downloadBtn][href]")
                if (links.size != 1) fail(Reason.INVALID)
                val downloadUri = requireDownloadUri(URI(links.single().absUrl("href")))
                if (candidates.putIfAbsent(downloadUri.toString(), Candidate(downloadUri, fileName.take(300), format)) != null) {
                    fail(Reason.INVALID)
                }
            }
            if (candidates.isEmpty()) fail(Reason.UNSUPPORTED)
            if (candidates.size > MAX_FILES || warnings.distinct().size > MAX_WARNINGS) fail(Reason.TOO_LARGE)
            val files = downloadWithinLimits(candidates.values, detailUri, warnings)
            SupportProgramAttachments(title, files, warnings.distinct(), detailUri.toString())
        } catch (error: SupportProgramDocumentException) {
            throw error
        } catch (error: Exception) {
            throw SupportProgramDocumentException(Reason.UNAVAILABLE, error)
        }
    }

    private fun downloadWithinLimits(
        candidates: Collection<Candidate>,
        detailUri: URI,
        warnings: MutableList<String>,
    ): List<SupportProgramAttachment> {
        val files = mutableListOf<SupportProgramAttachment>()
        var totalBytes = 0
        var skippedForSize = false
        candidates.forEach { candidate ->
            val bytes = try {
                download(candidate.uri, detailUri)
            } catch (error: SupportProgramDocumentException) {
                if (error.reason != Reason.TOO_LARGE) throw error
                skippedForSize = true
                warnings.add("미수집 첨부(파일 크기 제한 초과): ${candidate.fileName.take(250)}")
                return@forEach
            }
            if (totalBytes + bytes.size > MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES) {
                skippedForSize = true
                warnings.add("미수집 첨부(공고별 전체 크기 제한 초과): ${candidate.fileName.take(250)}")
                return@forEach
            }
            files.add(SupportProgramAttachment(candidate.uri.toString(), candidate.fileName, candidate.format, bytes))
            totalBytes += bytes.size
        }
        if (files.isEmpty()) fail(if (skippedForSize) Reason.TOO_LARGE else Reason.UNSUPPORTED)
        return files
    }

    private fun fetchPage(uri: URI): String = restClient.get().uri(uri).accept(MediaType.TEXT_HTML).exchange { _, response ->
        if (response.statusCode.value() == 404) fail(Reason.NOT_FOUND)
        if (response.statusCode.value() != 200) fail(Reason.UNAVAILABLE)
        if (response.headers.contentLength > MAX_PAGE_BYTES) fail(Reason.TOO_LARGE)
        response.body.readNBytes(MAX_PAGE_BYTES + 1).also { bytes ->
            if (bytes.isEmpty()) fail(Reason.INVALID)
            if (bytes.size > MAX_PAGE_BYTES) fail(Reason.TOO_LARGE)
        }.toString(StandardCharsets.UTF_8)
    }

    private fun download(uri: URI, referer: URI): ByteArray = restClient.get().uri(uri)
        .header(HttpHeaders.REFERER, referer.toString()).accept(MediaType.ALL).exchange { _, response ->
            if (response.statusCode.value() == 404) fail(Reason.NOT_FOUND)
            if (response.statusCode.value() != 200) fail(Reason.UNAVAILABLE)
            if (response.headers.contentLength > MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES) fail(Reason.TOO_LARGE)
            response.body.readNBytes(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1).also { bytes ->
                if (bytes.isEmpty()) fail(Reason.INVALID)
                if (bytes.size > MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES) fail(Reason.TOO_LARGE)
            }
        }

    internal fun requireDetailUri(uri: URI, sourceProgramId: String): URI {
        if (uri.scheme != "https" || uri.host !in HOSTS || uri.userInfo != null || uri.fragment != null ||
            uri.port !in listOf(-1, 443) || uri.path !in DETAIL_PATHS) fail(Reason.INVALID)
        val parameters = parameters(uri)
        if (parameters.keys.any { it !in setOf("pbancSn", "schM") } || parameters["pbancSn"] != listOf(sourceProgramId) ||
            parameters["schM"]?.let { it != listOf("view") } == true) fail(Reason.INVALID)
        return uri
    }

    internal fun requireDownloadUri(uri: URI): URI {
        if (uri.scheme != "https" || uri.host !in HOSTS || uri.userInfo != null || uri.fragment != null ||
            uri.port !in listOf(-1, 443) || uri.rawQuery != null || !DOWNLOAD_PATH.matches(uri.path)) fail(Reason.INVALID)
        return uri
    }

    private fun parameters(uri: URI): Map<String, List<String>> = uri.rawQuery.orEmpty().split('&')
        .filter(String::isNotBlank).groupBy(
            { URLDecoder.decode(it.substringBefore('='), StandardCharsets.UTF_8) },
            { URLDecoder.decode(it.substringAfter('=', ""), StandardCharsets.UTF_8) },
        )

    private fun format(fileName: String): String? = when {
        Regex("(?i)\\.hwpx(?:\\s|$)").containsMatchIn(fileName) -> "HWPX"
        Regex("(?i)\\.hwp(?:\\s|$)").containsMatchIn(fileName) -> "HWP"
        Regex("(?i)\\.pdf(?:\\s|$)").containsMatchIn(fileName) -> "PDF"
        else -> null
    }

    private fun fail(reason: Reason): Nothing = throw SupportProgramDocumentException(reason)
    private data class Candidate(val uri: URI, val fileName: String, val format: String)

    private companion object {
        const val MAX_PAGE_BYTES = 1_000_000
        const val MAX_FILES = 8
        const val MAX_WARNINGS = 16
        val HOSTS = setOf("k-startup.go.kr", "www.k-startup.go.kr")
        val DETAIL_PATHS = setOf("/web/contents/bizpbanc-ongoing.do", "/web/contents/bizpbanc-deadline.do")
        val PROGRAM_ID = Regex("[1-9][0-9]{0,254}")
        val REDIRECT = Regex("var\\s+fullUrl\\s*=\\s*['\"]([^'\"]+)['\"]\\s*;")
        val DOWNLOAD_PATH = Regex("/afile/fileDownload/[A-Za-z0-9_-]{1,200}")
    }
}
