package ai.govbiz.core.supportprogram.client.cntradenotice

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient
import org.springframework.web.util.UriComponentsBuilder

class CnTradeNoticeAttachmentClientLinksTest {
    private val builder = RestClient.builder()
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = CnTradeNoticeAttachmentClient(builder.build())
    private val title = "충남 수출지원 공고"
    private val index = "a".repeat(64)
    private val key = "b".repeat(64)
    private val detail = uri("act" to "detail", "idx" to index, "deleteAt" to "N", "pageIndex" to "1")

    @Test
    fun listsTheVerifiedBoardFilesAndDownloadsThemWithTheBoardAsReferer() {
        server.expect(requestTo(uri("searchValue1" to "title", "searchKeyword" to title, "pageIndex" to "1"))).andRespond(withSuccess("""
            <div class="page_area">총 게시물 <span class="green">1</span> 개</div>
            <table class="table_basics_area"><tbody>
              <tr><td class="tit"><a onclick="fn_edit('detail', '$index', 'N');"><span class="txt">$title</span></a></td></tr>
            </tbody></table>
        """.trimIndent(), MediaType.TEXT_HTML))
        server.expect(requestTo(detail)).andRespond(withSuccess("""
            <div class="board_view">
              <div class="board_view_top"><strong class="tit">$title</strong></div>
              <div class="board_view_con"><div class="editor_view">공식 본문 내용</div></div>
              <div class="board_view_file">
                <div class="file_each"><a class="down_txt" onclick="kssFileDownloadForKeyAct('$key')">신청서.hwp</a></div>
                <div class="file_each"><a class="down_txt" onclick="kssFileDownloadForKeyAct('${"c".repeat(64)}')">현수막.png</a></div>
              </div>
            </div>
        """.trimIndent(), MediaType.TEXT_HTML))
        server.expect(requestTo(DOWNLOAD)).andExpect(method(HttpMethod.POST)).andExpect(header(HttpHeaders.REFERER, detail.toString()))
            .andExpect(content().string("uniqueKey=$key"))
            .andRespond(withSuccess(byteArrayOf(9), MediaType.APPLICATION_OCTET_STREAM))

        val links = client.links("1", title, "공식 본문 내용")
        var received = byteArrayOf()
        client.open(links.single()) { _, body -> received = body.readAllBytes() }

        assertEquals("신청서.hwp", links.single().fileName)
        assertArrayEquals(byteArrayOf(9), received)
        server.verify()
    }

    private fun uri(vararg parameters: Pair<String, String>) = UriComponentsBuilder.fromUriString(BOARD).also { builder ->
        parameters.forEach { (name, value) -> builder.queryParam(name, value) }
    }.build().encode().toUri()

    private companion object {
        const val BOARD = "https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do"
        const val DOWNLOAD = "https://cntrade.chungnam.go.kr/fileDownload.do"
    }
}
