package ai.govbiz.core.supportprogram.client.bizinfo

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import org.jsoup.Jsoup
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** 기업마당 공고 ID로 공식 페이지를 찾고 그 페이지가 직접 연결한 PDF/HWP/HWPX 첨부만 수집합니다. */
@Component
class BizInfoAttachmentClient(
    private val htmlClient: BizInfoSourceDocumentClient,
    @param:Qualifier("bizInfoSourceDocumentRestClient") private val restClient: RestClient,
) {
    fun collect(sourceCode: String, sourceProgramId: String): SupportProgramAttachments {
        if (sourceCode != "BIZINFO" || !Regex("PBLN_[0-9]{1,32}").matches(sourceProgramId)) fail(Reason.UNSUPPORTED)
        try {
            val url = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=$sourceProgramId"
            val page = Jsoup.parse(htmlClient.fetchHtml(url, sourceProgramId), url)
            val detail = page.selectFirst(".support_project_detail") ?: fail(Reason.NOT_FOUND)
            val title = detail.selectFirst(".title_area .title")?.text()?.trim().orEmpty()
            if (title.isBlank()) fail(Reason.NOT_FOUND)
            val links = linkedMapOf<String, Pair<String, String>>()
            val warnings = mutableListOf("공식 페이지가 직접 연결한 PDF/HWP/HWPX만 수집했습니다. 추출 문항은 사용자가 원문과 대조해야 합니다.")
            detail.select(".file_name").forEach { name ->
                val anchor = name.parent()?.selectFirst("a[href*='/cmm/fms/fileDown.do']")
                if (anchor != null) addLink(links, warnings, anchor.absUrl("href"), name.text())
            }
            val mssPages = detail.select("a[href]").mapNotNull { anchor ->
                runCatching { URI(anchor.absUrl("href")) }.getOrNull()?.takeIf(::isMssPage)
            }.distinct()
            if (mssPages.size > 1) fail(Reason.INVALID)
            mssPages.singleOrNull()?.let { mss ->
                val linked = Jsoup.parse(String(download(mss, 500_000), StandardCharsets.UTF_8), mss.toString())
                val board = linked.selectFirst(".board_view") ?: fail(Reason.INVALID)
                board.select("a[href*='/common/board/Download.do']").forEach { anchor ->
                    val label = anchor.parent()?.selectFirst(".name")?.text()
                        ?: anchor.parent()?.parent()?.selectFirst(".name")?.text().orEmpty()
                    addLink(links, warnings, anchor.absUrl("href"), label)
                }
            }
            val primaryNames = links.filter { (link, descriptor) ->
                URI(link).host in setOf("mss.go.kr", "www.mss.go.kr") && descriptor.second == "HWPX"
            }.values.map { normalizedTitle(it.first) }.toSet()
            val selected = links.filter { (link, descriptor) ->
                val mirrored = URI(link).host in setOf("bizinfo.go.kr", "www.bizinfo.go.kr") &&
                    normalizedTitle(descriptor.first) in primaryNames
                if (mirrored) warnings.add("동일 표제의 기업마당 변환본 대신 발행기관 중기부 HWPX를 사용했습니다: ${descriptor.first.take(200)}")
                !mirrored
            }
            if (selected.isEmpty()) fail(Reason.UNSUPPORTED)
            if (selected.size > 4 || warnings.distinct().size > 12) fail(Reason.TOO_LARGE)
            val files = mutableListOf<SupportProgramAttachment>()
            var totalBytes = 0
            var skippedForSize = false
            selected.forEach { (link, descriptor) ->
                val bytes = try {
                    download(URI(link), MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES)
                } catch (error: SupportProgramDocumentException) {
                    if (error.reason != Reason.TOO_LARGE) throw error
                    skippedForSize = true
                    warnings.add("미수집 첨부(파일 크기 제한 초과): ${descriptor.first.take(250)}")
                    return@forEach
                }
                if (totalBytes + bytes.size > MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES) {
                    skippedForSize = true
                    warnings.add("미수집 첨부(공고별 전체 크기 제한 초과): ${descriptor.first.take(250)}")
                    return@forEach
                }
                files.add(SupportProgramAttachment(link, descriptor.first.take(300), descriptor.second, bytes))
                totalBytes += bytes.size
            }
            if (files.isEmpty()) fail(if (skippedForSize) Reason.TOO_LARGE else Reason.UNSUPPORTED)
            return SupportProgramAttachments(title, files, warnings.distinct(), url)
        } catch (error: SupportProgramDocumentException) {
            throw error
        } catch (error: Exception) {
            throw SupportProgramDocumentException(Reason.UNAVAILABLE, cause = error)
        }
    }

    private fun addLink(links: MutableMap<String, Pair<String, String>>, warnings: MutableList<String>, url: String, name: String) {
        val format = when {
            Regex("(?i)\\.hwpx(?:\\s|$)").containsMatchIn(name) -> "HWPX"
            Regex("(?i)\\.hwp(?:\\s|$)").containsMatchIn(name) -> "HWP"
            Regex("(?i)\\.pdf(?:\\s|$)").containsMatchIn(name) -> "PDF"
            else -> null
        }
        if (format == null) {
            warnings.add("미수집 첨부(지원 형식 PDF/HWP/HWPX 이외): ${name.take(250)}")
            return
        }
        val uri = URI(url)
        requireTrustedUri(uri)
        links[uri.toString()] = name to format
    }

    private fun normalizedTitle(name: String): String = name.replace(Regex("(?i)\\.(hwpx|hwp|pdf).*"), "")
        .replace(Regex("[^\\p{L}\\p{N}]"), "").lowercase()

    private fun download(uri: URI, limit: Int): ByteArray {
        requireTrustedUri(uri)
        return restClient.get().uri(uri).accept(MediaType.ALL).exchange { _, response ->
            if (response.statusCode.value() == 404) fail(Reason.NOT_FOUND)
            if (response.statusCode.value() != 200) fail(Reason.UNAVAILABLE)
            if (response.headers.contentLength > limit) fail(Reason.TOO_LARGE)
            val bytes = response.body.readNBytes(limit + 1)
            if (bytes.isEmpty()) fail(Reason.INVALID)
            if (bytes.size > limit) fail(Reason.TOO_LARGE)
            bytes
        }
    }

    internal fun requireTrustedUri(uri: URI) {
        if (uri.scheme != "https" || uri.userInfo != null || uri.fragment != null || uri.port !in listOf(-1, 443)) fail(Reason.INVALID)
        val query = uri.rawQuery.orEmpty().split('&').map { it.substringBefore('=') }
        if (query.size != query.distinct().size) fail(Reason.INVALID)
        val valid = when (uri.host) {
            "www.bizinfo.go.kr", "bizinfo.go.kr" -> uri.path == "/cmm/fms/fileDown.do" && query.toSet() == setOf("atchFileId", "fileSn") &&
                Regex("FILE_[0-9]+").matches(parameter(uri, "atchFileId")) && Regex("[0-9]+").matches(parameter(uri, "fileSn"))
            "www.mss.go.kr", "mss.go.kr" -> isMssPage(uri) || (uri.path == "/common/board/Download.do" &&
                query.toSet() == setOf("bcIdx", "cbIdx", "streFileNm") && parameter(uri, "cbIdx") == "310" &&
                Regex("[0-9]+").matches(parameter(uri, "bcIdx")) &&
                Regex("[A-Za-z0-9-]+\\.(hwpx|hwp|pdf)", RegexOption.IGNORE_CASE).matches(parameter(uri, "streFileNm")))
            else -> false
        }
        if (!valid) fail(Reason.INVALID)
    }

    private fun isMssPage(uri: URI): Boolean = uri.scheme == "https" && uri.host in setOf("mss.go.kr", "www.mss.go.kr") &&
        uri.userInfo == null && uri.port in listOf(-1, 443) && uri.path == "/site/smba/ex/bbs/View.do" &&
        parameter(uri, "cbIdx") == "310" && Regex("[0-9]+").matches(parameter(uri, "bcIdx"))

    private fun parameter(uri: URI, name: String): String = uri.rawQuery.orEmpty().split('&')
        .singleOrNull { it.substringBefore('=') == name }?.substringAfter('=', "")
        ?.let { URLDecoder.decode(it, StandardCharsets.UTF_8) }.orEmpty()

    private fun fail(reason: Reason): Nothing = throw SupportProgramDocumentException(reason)
}
