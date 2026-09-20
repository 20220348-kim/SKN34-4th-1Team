package ai.govbiz.core.supportprogram.client.cntradenotice

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient
import org.springframework.web.util.UriComponentsBuilder

class CnTradeNoticeAttachmentClientTest {
    private val builder = RestClient.builder()
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = CnTradeNoticeAttachmentClient(builder.build())
    private val title = "충남 수출지원 공고"
    private val index = "a".repeat(64)
    private val key = "b".repeat(64)
    private val detail = uri("act" to "detail", "idx" to index, "deleteAt" to "N", "pageIndex" to "1")

    @Test
    fun resolvesOneMatchingOfficialPostAndDownloadsItsAttachment() {
        server.expect(requestTo(search())).andRespond(withSuccess(listPage(), MediaType.TEXT_HTML))
        server.expect(requestTo(detail)).andRespond(withSuccess(detailPage(), MediaType.TEXT_HTML))
        server.expect(requestTo(DOWNLOAD)).andExpect(header(HttpHeaders.REFERER, detail.toString()))
            .andExpect(content().string("uniqueKey=$key"))
            .andRespond(withSuccess(byteArrayOf(4, 5, 6), MediaType.APPLICATION_OCTET_STREAM))

        val result = client.collect("CNTRADE_NOTICE", "3862", title, "공식 본문 내용")

        assertEquals(title, result.programTitle)
        assertEquals(detail.toString(), result.sourcePageUrl)
        assertEquals("신청서.pdf", result.files.single().fileName)
        assertEquals("PDF", result.files.single().format)
        assertArrayEquals(byteArrayOf(4, 5, 6), result.files.single().bytes)
        assertTrue(result.warnings.single().contains("교차 검증"))
        server.verify()
    }

    @Test
    fun rejectsAWebPostWhoseBodyDoesNotMatchTheOpenApiRecord() {
        server.expect(requestTo(search())).andRespond(withSuccess(listPage(), MediaType.TEXT_HTML))
        server.expect(requestTo(detail)).andRespond(withSuccess(detailPage(body = "다른 본문"), MediaType.TEXT_HTML))

        assertEquals(Reason.NOT_FOUND, assertThrows(SupportProgramDocumentException::class.java) {
            client.collect("CNTRADE_NOTICE", "3862", title, "공식 본문 내용")
        }.reason)
        server.verify()
    }

    @Test
    fun refusesToGuessWhenTwoPostsMatchTheSameOfficialRecord() {
        val secondIndex = "c".repeat(64)
        val secondDetail = uri("act" to "detail", "idx" to secondIndex, "deleteAt" to "N", "pageIndex" to "1")
        server.expect(requestTo(search())).andRespond(withSuccess(listPage(listOf(index, secondIndex), 2), MediaType.TEXT_HTML))
        server.expect(requestTo(detail)).andRespond(withSuccess(detailPage(), MediaType.TEXT_HTML))
        server.expect(requestTo(secondDetail)).andRespond(withSuccess(detailPage(), MediaType.TEXT_HTML))

        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) {
            client.collect("CNTRADE_NOTICE", "3862", title, "공식 본문 내용")
        }.reason)
        server.verify()
    }

    private fun search() = uri("searchValue1" to "title", "searchKeyword" to title, "pageIndex" to "1")
    private fun uri(vararg parameters: Pair<String, String>) = UriComponentsBuilder.fromUriString(BOARD).also { builder ->
        parameters.forEach { (name, value) -> builder.queryParam(name, value) }
    }.build().encode().toUri()

    private fun listPage(indexes: List<String> = listOf(index), total: Int = indexes.size) = """
        <div class="page_area">총 게시물 <span class="green">$total</span> 개</div>
        <table class="table_basics_area"><tbody>${indexes.joinToString("") { value -> """
          <tr><td class="tit"><a onclick="fn_edit('detail', '$value', 'N');"><span class="txt">$title</span></a></td></tr>
        """ }}</tbody></table>
    """.trimIndent()

    private fun detailPage(body: String = "공식 본문 내용") = """
        <div class="board_view">
          <div class="board_view_top"><strong class="tit">$title</strong></div>
          <div class="board_view_con"><div class="editor_view">$body</div></div>
          <div class="board_view_file"><div class="file_each">
            <a class="down_txt" onclick="kssFileDownloadForKeyAct('$key')">신청서.pdf</a>
          </div></div>
        </div>
    """.trimIndent()

    private companion object {
        const val BOARD = "https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do"
        const val DOWNLOAD = "https://cntrade.chungnam.go.kr/fileDownload.do"
    }
}
