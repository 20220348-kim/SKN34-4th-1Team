package ai.govbiz.core.supportprogram.client.msit

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class MsitAttachmentClientLinksTest {
    private val builder = RestClient.builder()
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = MsitAttachmentClient(builder.build())
    private val id = "3186573"
    private val pageUrl = "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&mId=311&mPid=121&nttSeqNo=$id&sCode=user"

    @Test
    fun listsDocumentsBeyondTheAnalysisFormatsAndDownloadsByPost() {
        server.expect(requestTo(pageUrl)).andRespond(withSuccess("""
            <div class="board_view"><div class="view_head"><h2>과기정통부 지원사업</h2></div>
              <div class="view_file"><ul class="down_file">
                <li><a title="HWPX 파일 다운로드">공고문.hwpx</a><a onclick="fn_download('55278', '1', 'hwpx');">다운로드</a></li>
                <li><a title="ODT 파일 다운로드">서식.odt</a><a onclick="fn_download('55278', '2', 'odt');">다운로드</a></li>
                <li><a title="PNG 파일 다운로드">안내.png</a><a onclick="fn_download('55278', '3', 'png');">다운로드</a></li>
              </ul></div>
            </div>
        """.trimIndent(), MediaType.TEXT_HTML))
        server.expect(requestTo("https://www.msit.go.kr/ssm/file/fileDown.do")).andExpect(method(HttpMethod.POST))
            .andExpect(content().string("atchFileNo=55278&fileOrd=2&fileBtn=A"))
            .andRespond(withSuccess(byteArrayOf(4, 5), MediaType.APPLICATION_OCTET_STREAM))

        val links = client.links(id, pageUrl)
        var received = byteArrayOf()
        client.open(links[1]) { _, body -> received = body.readAllBytes() }

        assertEquals(listOf("공고문.hwpx" to "hwpx", "서식.odt" to "odt"), links.map { it.fileName to it.extension })
        assertArrayEquals(byteArrayOf(4, 5), received)
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) {
            client.open(links[1].copy(url = "https://www.msit.go.kr/ssm/file/fileDown.do?atchFileNo=1&fileOrd=1&fileBtn=A&x=1")) { _, _ -> }
        }.reason)
        server.verify()
    }
}
