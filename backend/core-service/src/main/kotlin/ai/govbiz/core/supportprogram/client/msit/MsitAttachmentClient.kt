package ai.govbiz.core.supportprogram.client.msit

import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import ai.govbiz.core.supportprogram.client.msit.helper.MsitDetailUrlHelper
import java.net.URI
import java.nio.charset.StandardCharsets
import org.jsoup.Jsoup
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** 과기정통부 사업공고 상세가 직접 연결한 PDF/HWP/HWPX 첨부만 수집합니다. */
@Component
class MsitAttachmentClient(
    @param:Qualifier("msitSourceDocumentRestClient") private val restClient: RestClient,
) {
    fun collect(sourceCode: String, sourceProgramId: String, sourceUrl: String): SupportProgramAttachments {
        if (sourceCode != "MSIT" || !PROGRAM_ID.matches(sourceProgramId)) fail(Reason.UNSUPPORTED)
        val sourceUri = try {
            URI(sourceUrl).also { uri ->
                if (MsitDetailUrlHelper.extractProgramId(uri.toString()) != sourceProgramId) fail(Reason.INVALID)
            }
        } catch (error: SupportProgramDocumentException) {
            throw error
        } catch (error: Exception) {
            throw SupportProgramDocumentException(Reason.INVALID, error)
        }
        try {
            val page = Jsoup.parse(String(fetchPage(sourceUri), StandardCharsets.UTF_8), sourceUri.toString())
            val board = page.selectFirst(".board_view") ?: fail(Reason.NOT_FOUND)
            val title = board.selectFirst(".view_head h2")?.text()?.trim().orEmpty()
            if (title.isBlank()) fail(Reason.NOT_FOUND)
            val warnings = mutableListOf("과기정통부 공식 페이지가 직접 연결한 PDF/HWP/HWPX만 수집했습니다. 추출 문항은 사용자가 원문과 대조해야 합니다.")
            val candidates = linkedMapOf<String, Candidate>()
            board.select(".view_file ul.down_file > li").forEach { item ->
                val fileName = item.selectFirst("a[title*='파일 다운로드']")?.text()?.trim()
                    ?: item.selectFirst("a")?.text()?.trim().orEmpty()
                val format = when {
                    Regex("(?i)\\.hwpx(?:\\s|$)").containsMatchIn(fileName) -> "HWPX"
                    Regex("(?i)\\.hwp(?:\\s|$)").containsMatchIn(fileName) -> "HWP"
                    Regex("(?i)\\.pdf(?:\\s|$)").containsMatchIn(fileName) -> "PDF"
                    else -> null
                }
                if (format == null) {
                    if (fileName.isNotBlank()) warnings.add("미수집 첨부(지원 형식 PDF/HWP/HWPX 이외): ${fileName.take(250)}")
                    return@forEach
                }
                val download = item.select("a[onclick]").mapNotNull { anchor ->
                    DOWNLOAD_CALL.matchEntire(anchor.attr("onclick").trim())
                }.singleOrNull() ?: fail(Reason.INVALID)
                val fileNumber = download.groupValues[1]
                val fileOrder = download.groupValues[2]
                val extension = download.groupValues[3].uppercase()
                if (extension != format) fail(Reason.INVALID)
                val key = "$fileNumber:$fileOrder"
                if (candidates.putIfAbsent(key, Candidate(fileNumber, fileOrder, fileName.take(300), format)) != null) fail(Reason.INVALID)
            }
            if (candidates.isEmpty()) fail(Reason.UNSUPPORTED)
            if (candidates.size > 8 || warnings.distinct().size > 16) fail(Reason.TOO_LARGE)
            val files = mutableListOf<SupportProgramAttachment>()
            var totalBytes = 0
            var skippedForSize = false
            candidates.values.forEach { candidate ->
                val bytes = try {
                    download(candidate, MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES)
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
                files.add(SupportProgramAttachment(candidate.sourceUrl(), candidate.fileName, candidate.format, bytes))
                totalBytes += bytes.size
            }
            if (files.isEmpty()) fail(if (skippedForSize) Reason.TOO_LARGE else Reason.UNSUPPORTED)
            return SupportProgramAttachments(title, files, warnings.distinct(), sourceUri.toString())
        } catch (error: SupportProgramDocumentException) {
            throw error
        } catch (error: Exception) {
            throw SupportProgramDocumentException(Reason.UNAVAILABLE, error)
        }
    }

    private fun fetchPage(uri: URI): ByteArray = restClient.get().uri(uri).accept(MediaType.TEXT_HTML).exchange { _, response ->
        if (response.statusCode.value() == 404) fail(Reason.NOT_FOUND)
        if (response.statusCode.value() != 200) fail(Reason.UNAVAILABLE)
        if (response.headers.contentLength > MAX_PAGE_BYTES) fail(Reason.TOO_LARGE)
        response.body.readNBytes(MAX_PAGE_BYTES + 1).also { bytes ->
            if (bytes.isEmpty()) fail(Reason.INVALID)
            if (bytes.size > MAX_PAGE_BYTES) fail(Reason.TOO_LARGE)
        }
    }

    private fun download(candidate: Candidate, limit: Int): ByteArray = restClient.post()
        .uri(DOWNLOAD_URI)
        .contentType(MediaType.APPLICATION_FORM_URLENCODED)
        .accept(MediaType.ALL)
        .body("atchFileNo=${candidate.fileNumber}&fileOrd=${candidate.fileOrder}&fileBtn=A")
        .exchange { _, response ->
            if (response.statusCode.value() == 404) fail(Reason.NOT_FOUND)
            if (response.statusCode.value() != 200) fail(Reason.UNAVAILABLE)
            if (response.headers.contentLength > limit) fail(Reason.TOO_LARGE)
            response.body.readNBytes(limit + 1).also { bytes ->
                if (bytes.isEmpty()) fail(Reason.INVALID)
                if (bytes.size > limit) fail(Reason.TOO_LARGE)
            }
        }

    private fun fail(reason: Reason): Nothing = throw SupportProgramDocumentException(reason)

    private data class Candidate(val fileNumber: String, val fileOrder: String, val fileName: String, val format: String) {
        fun sourceUrl() = "$DOWNLOAD_URI?atchFileNo=$fileNumber&fileOrd=$fileOrder&fileBtn=A"
    }

    private companion object {
        const val MAX_PAGE_BYTES = 1_000_000
        const val DOWNLOAD_URI = "https://www.msit.go.kr/ssm/file/fileDown.do"
        val PROGRAM_ID = Regex("[1-9][0-9]{0,254}")
        val DOWNLOAD_CALL = Regex("fn_download\\('([1-9][0-9]{0,20})',\\s*'([1-9][0-9]{0,5})',\\s*'(hwpx|hwp|pdf)'\\);", RegexOption.IGNORE_CASE)
    }
}
