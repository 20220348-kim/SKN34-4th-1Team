package ai.govbiz.core.supportprogram.client.msit

import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachmentLink
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import ai.govbiz.core.supportprogram.client.document.helper.SupportProgramAttachmentLinkHelper
import ai.govbiz.core.supportprogram.client.msit.helper.MsitDetailUrlHelper
import java.io.InputStream
import java.net.URI
import java.nio.charset.StandardCharsets
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** 과기정통부 사업공고 상세가 직접 연결한 PDF/HWP/HWPX/DOCX/XLSX 첨부만 수집합니다. */
@Component
class MsitAttachmentClient(
    @param:Qualifier("msitSourceDocumentRestClient") private val restClient: RestClient,
) {
    fun collect(sourceCode: String, sourceProgramId: String, sourceUrl: String): SupportProgramAttachments {
        if (sourceCode != "MSIT" || !PROGRAM_ID.matches(sourceProgramId)) fail(Reason.UNSUPPORTED)
        val sourceUri = sourceUri(sourceProgramId, sourceUrl)
        try {
            val board = board(sourceUri)
            val title = board.selectFirst(".view_head h2")?.text()?.trim().orEmpty()
            val warnings = mutableListOf("과기정통부 공식 페이지가 직접 연결한 PDF/HWP/HWPX/DOCX/XLSX만 수집했습니다. 추출 문항은 사용자가 원문과 대조해야 합니다.")
            val candidates = linkedMapOf<String, Candidate>()
            board.select(".view_file ul.down_file > li").forEach { item ->
                val fileName = item.selectFirst("a[title*='파일 다운로드']")?.text()?.trim()
                    ?: item.selectFirst("a")?.text()?.trim().orEmpty()
                val format = when {
                    Regex("(?i)\\.docx(?:\\s|$)").containsMatchIn(fileName) -> "DOCX"
                    Regex("(?i)\\.xlsx(?:\\s|$)").containsMatchIn(fileName) -> "XLSX"
                    Regex("(?i)\\.hwpx(?:\\s|$)").containsMatchIn(fileName) -> "HWPX"
                    Regex("(?i)\\.hwp(?:\\s|$)").containsMatchIn(fileName) -> "HWP"
                    Regex("(?i)\\.pdf(?:\\s|$)").containsMatchIn(fileName) -> "PDF"
                    else -> null
                }
                if (format == null) {
                    if (fileName.isNotBlank()) warnings.add("미수집 첨부(지원 형식 PDF/HWP/HWPX/DOCX/XLSX 이외): ${fileName.take(250)}")
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

    /** 공고 상세에 보여 줄 첨부 목록입니다. 분석용 [collect]와 달리 형식·개수를 거르지 않고 이미지만 빼며 파일은 받지 않습니다. */
    fun links(sourceProgramId: String, sourceUrl: String): List<SupportProgramAttachmentLink> {
        if (!PROGRAM_ID.matches(sourceProgramId)) fail(Reason.UNSUPPORTED)
        val sourceUri = sourceUri(sourceProgramId, sourceUrl)
        try {
            return SupportProgramAttachmentLinkHelper.visible(board(sourceUri).select(".view_file ul.down_file > li").mapNotNull { item ->
                val fileName = item.selectFirst("a[title*='파일 다운로드']")?.text() ?: item.selectFirst("a")?.text().orEmpty()
                val call = item.select("a[onclick]").mapNotNull { anchor -> LINK_CALL.matchEntire(anchor.attr("onclick").trim()) }
                    .singleOrNull() ?: return@mapNotNull null
                SupportProgramAttachmentLinkHelper.link(fileName, "$DOWNLOAD_URI?atchFileNo=${call.groupValues[1]}&fileOrd=${call.groupValues[2]}&fileBtn=A")
            })
        } catch (error: SupportProgramDocumentException) {
            throw error
        } catch (error: Exception) {
            throw SupportProgramDocumentException(Reason.UNAVAILABLE, error)
        }
    }

    /** [links]가 돌려준 첨부 하나를 원본에서 받아 길이(모르면 -1)와 본문을 [receive]로 넘깁니다. */
    fun open(link: SupportProgramAttachmentLink, receive: (Long, InputStream) -> Unit) {
        val download = DOWNLOAD_LINK.matchEntire(link.url) ?: fail(Reason.INVALID)
        restClient.post().uri(DOWNLOAD_URI).contentType(MediaType.APPLICATION_FORM_URLENCODED).accept(MediaType.ALL)
            .body("atchFileNo=${download.groupValues[1]}&fileOrd=${download.groupValues[2]}&fileBtn=A")
            .exchange { _, response -> SupportProgramAttachmentLinkHelper.receive(response, receive) }
    }

    private fun sourceUri(sourceProgramId: String, sourceUrl: String): URI = try {
        URI(sourceUrl).also { uri ->
            if (MsitDetailUrlHelper.extractProgramId(uri.toString()) != sourceProgramId) fail(Reason.INVALID)
        }
    } catch (error: SupportProgramDocumentException) {
        throw error
    } catch (error: Exception) {
        throw SupportProgramDocumentException(Reason.INVALID, error)
    }

    private fun board(sourceUri: URI): Element {
        val page = Jsoup.parse(String(fetchPage(sourceUri), StandardCharsets.UTF_8), sourceUri.toString())
        val board = page.selectFirst(".board_view") ?: fail(Reason.NOT_FOUND)
        if (board.selectFirst(".view_head h2")?.text()?.trim().isNullOrBlank()) fail(Reason.NOT_FOUND)
        return board
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
        val DOWNLOAD_CALL = Regex("fn_download\\('([1-9][0-9]{0,20})',\\s*'([1-9][0-9]{0,5})',\\s*'(hwpx|hwp|pdf|docx|xlsx)'\\);", RegexOption.IGNORE_CASE)
        /** 상세 첨부 목록은 분석 형식 밖의 파일(zip·odt 등)도 보여 줍니다. */
        val LINK_CALL = Regex("fn_download\\('([1-9][0-9]{0,20})',\\s*'([1-9][0-9]{0,5})',\\s*'[A-Za-z0-9]{1,10}'\\);")
        val DOWNLOAD_LINK = Regex("https://www\\.msit\\.go\\.kr/ssm/file/fileDown\\.do\\?atchFileNo=([1-9][0-9]{0,20})&fileOrd=([1-9][0-9]{0,5})&fileBtn=A")
    }
}
