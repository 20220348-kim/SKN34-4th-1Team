package ai.govbiz.core.supportprogram.client.cntradenotice

import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import java.net.URI
import java.nio.charset.StandardCharsets
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import org.springframework.web.util.UriComponentsBuilder

/** 충남 OpenAPI 공고를 공식 게시판 내용과 교차 검증한 뒤 게시판이 제공한 첨부만 수집합니다. */
@Component
class CnTradeNoticeAttachmentClient(
    @param:Qualifier("cnTradeNoticeSourceDocumentRestClient") private val restClient: RestClient,
) {
    fun collect(
        sourceCode: String,
        sourceProgramId: String,
        expectedTitle: String,
        expectedBody: String,
    ): SupportProgramAttachments {
        if (sourceCode != "CNTRADE_NOTICE" || !NOTICE_ID.matches(sourceProgramId) || expectedTitle.isBlank()) {
            fail(Reason.UNSUPPORTED)
        }
        return try {
            val candidates = findCandidates(expectedTitle)
            if (candidates.isEmpty()) fail(Reason.NOT_FOUND)
            val matching = candidates.map { candidate -> candidate to fetchDetail(candidate) }
                .filter { (_, page) -> matchesOfficialRecord(page, expectedTitle, expectedBody) }
            if (matching.size != 1) fail(if (matching.isEmpty()) Reason.NOT_FOUND else Reason.INVALID)
            val (candidate, detail) = matching.single()
            val warnings = mutableListOf("충남 공식 게시판에서 제목·본문을 교차 검증한 PDF/HWP/HWPX만 수집했습니다. 추출 결과는 사용자가 원문과 대조해야 합니다.")
            val files = collectFiles(detail, candidate.detailUri, warnings)
            SupportProgramAttachments(expectedTitle, files, warnings.distinct(), candidate.detailUri.toString())
        } catch (error: SupportProgramDocumentException) {
            throw error
        } catch (error: Exception) {
            throw SupportProgramDocumentException(Reason.UNAVAILABLE, error)
        }
    }

    private fun findCandidates(expectedTitle: String): List<Candidate> {
        val first = fetchPage(searchUri(expectedTitle, 1))
        val total = first.selectFirst(".page_area .green")?.text()?.replace(",", "")?.toIntOrNull() ?: fail(Reason.INVALID)
        if (total == 0) return emptyList()
        if (total > MAX_SEARCH_RESULTS) fail(Reason.TOO_LARGE)
        val candidates = linkedMapOf<String, Candidate>()
        val pages = maxOf(1, (total + PAGE_SIZE - 1) / PAGE_SIZE)
        for (pageNumber in 1..pages) {
            val page = if (pageNumber == 1) first else fetchPage(searchUri(expectedTitle, pageNumber))
            page.select("table.table_basics_area tbody tr").forEach { row ->
                val title = row.selectFirst("td.tit .txt")?.text()?.trim().orEmpty()
                if (title != expectedTitle) return@forEach
                val call = row.selectFirst("td.tit a[onclick]")?.attr("onclick")?.trim().orEmpty()
                val index = DETAIL_CALL.matchEntire(call)?.groupValues?.get(1) ?: fail(Reason.INVALID)
                val detailUri = detailUri(index, pageNumber)
                if (candidates.putIfAbsent(index, Candidate(detailUri)) != null) fail(Reason.INVALID)
            }
        }
        return candidates.values.toList()
    }

    private fun fetchDetail(candidate: Candidate): Document = fetchPage(candidate.detailUri).also { page ->
        if (page.selectFirst(".board_view") == null) fail(Reason.NOT_FOUND)
    }

    private fun matchesOfficialRecord(page: Document, expectedTitle: String, expectedBody: String): Boolean {
        val title = page.selectFirst(".board_view_top strong.tit")?.text()?.trim().orEmpty()
        if (title != expectedTitle) return false
        if (expectedBody.isBlank() || expectedBody == "정보 없음") return true
        val body = page.selectFirst(".board_view_con .editor_view")?.text()?.trim().orEmpty()
        return normalize(body) == normalize(expectedBody)
    }

    private fun collectFiles(page: Document, detailUri: URI, warnings: MutableList<String>): List<SupportProgramAttachment> {
        val candidates = linkedMapOf<String, FileCandidate>()
        page.select(".board_view_file .file_each").forEach { item ->
            val anchor = item.selectFirst("a.down_txt[onclick]") ?: return@forEach
            val fileName = anchor.text().trim()
            val format = format(fileName)
            if (format == null) {
                if (fileName.isNotBlank()) warnings.add("미수집 첨부(지원 형식 PDF/HWP/HWPX 이외): ${fileName.take(250)}")
                return@forEach
            }
            val key = DOWNLOAD_CALL.matchEntire(anchor.attr("onclick").trim())?.groupValues?.get(1) ?: fail(Reason.INVALID)
            if (candidates.putIfAbsent(key, FileCandidate(key, fileName.take(300), format)) != null) fail(Reason.INVALID)
        }
        if (candidates.isEmpty()) fail(Reason.UNSUPPORTED)
        if (candidates.size > MAX_FILES || warnings.distinct().size > MAX_WARNINGS) fail(Reason.TOO_LARGE)
        val files = mutableListOf<SupportProgramAttachment>()
        var totalBytes = 0
        var skippedForSize = false
        candidates.values.forEach { candidate ->
            val bytes = try {
                download(candidate.key, detailUri)
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
            files.add(SupportProgramAttachment("$DOWNLOAD_URI?uniqueKey=${candidate.key}", candidate.fileName, candidate.format, bytes))
            totalBytes += bytes.size
        }
        if (files.isEmpty()) fail(if (skippedForSize) Reason.TOO_LARGE else Reason.UNSUPPORTED)
        return files
    }

    private fun fetchPage(uri: URI): Document = restClient.get().uri(uri).accept(MediaType.TEXT_HTML).exchange { _, response ->
        if (response.statusCode.value() == 404) fail(Reason.NOT_FOUND)
        if (response.statusCode.value() != 200) fail(Reason.UNAVAILABLE)
        if (response.headers.contentLength > MAX_PAGE_BYTES) fail(Reason.TOO_LARGE)
        response.body.readNBytes(MAX_PAGE_BYTES + 1).also { bytes ->
            if (bytes.isEmpty()) fail(Reason.INVALID)
            if (bytes.size > MAX_PAGE_BYTES) fail(Reason.TOO_LARGE)
        }.let { bytes -> Jsoup.parse(bytes.toString(StandardCharsets.UTF_8), uri.toString()) }
    }

    private fun download(key: String, referer: URI): ByteArray = restClient.post().uri(DOWNLOAD_URI)
        .header(HttpHeaders.REFERER, referer.toString()).contentType(MediaType.APPLICATION_FORM_URLENCODED)
        .accept(MediaType.ALL).body("uniqueKey=$key").exchange { _, response ->
            if (response.statusCode.value() == 404) fail(Reason.NOT_FOUND)
            if (response.statusCode.value() != 200) fail(Reason.UNAVAILABLE)
            if (response.headers.contentLength > MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES) fail(Reason.TOO_LARGE)
            response.body.readNBytes(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1).also { bytes ->
                if (bytes.isEmpty()) fail(Reason.INVALID)
                if (bytes.size > MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES) fail(Reason.TOO_LARGE)
            }
        }

    private fun searchUri(title: String, page: Int): URI = UriComponentsBuilder.fromUriString(BOARD_URI)
        .queryParam("searchValue1", "title").queryParam("searchKeyword", title).queryParam("pageIndex", page)
        .build().encode().toUri()

    private fun detailUri(index: String, page: Int): URI = UriComponentsBuilder.fromUriString(BOARD_URI)
        .queryParam("act", "detail").queryParam("idx", index).queryParam("deleteAt", "N").queryParam("pageIndex", page)
        .build().encode().toUri()

    private fun normalize(text: String): String = text.replace(Regex("\\s+"), "").trim()
    private fun format(fileName: String): String? = when {
        Regex("(?i)\\.hwpx(?:\\s|$)").containsMatchIn(fileName) -> "HWPX"
        Regex("(?i)\\.hwp(?:\\s|$)").containsMatchIn(fileName) -> "HWP"
        Regex("(?i)\\.pdf(?:\\s|$)").containsMatchIn(fileName) -> "PDF"
        else -> null
    }

    private fun fail(reason: Reason): Nothing = throw SupportProgramDocumentException(reason)
    private data class Candidate(val detailUri: URI)
    private data class FileCandidate(val key: String, val fileName: String, val format: String)

    private companion object {
        const val BOARD_URI = "https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do"
        const val DOWNLOAD_URI = "https://cntrade.chungnam.go.kr/fileDownload.do"
        const val MAX_PAGE_BYTES = 1_000_000
        const val MAX_SEARCH_RESULTS = 20
        const val PAGE_SIZE = 10
        const val MAX_FILES = 8
        const val MAX_WARNINGS = 16
        val NOTICE_ID = Regex("[1-9][0-9]{0,254}")
        val DETAIL_CALL = Regex("fn_edit\\('detail',\\s*'([0-9a-f]{64})',\\s*'N'\\);", RegexOption.IGNORE_CASE)
        val DOWNLOAD_CALL = Regex("kssFileDownloadForKeyAct\\('([0-9a-f]{64})'\\)", RegexOption.IGNORE_CASE)
    }
}
