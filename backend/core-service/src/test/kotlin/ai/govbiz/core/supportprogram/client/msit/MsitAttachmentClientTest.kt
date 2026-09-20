package ai.govbiz.core.supportprogram.client.msit

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class MsitAttachmentClientTest {
    private val builder = RestClient.builder()
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = MsitAttachmentClient(builder.build())
    private val sourceProgramId = "3186573"
    private val pageUrl = "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&mId=311&mPid=121&nttSeqNo=$sourceProgramId&sCode=user"
    private val downloadUrl = "https://www.msit.go.kr/ssm/file/fileDown.do"

    @Test
    fun collectsOnlySupportedFilesLinkedByTheMatchingOfficialDetail() {
        server.expect(requestTo(pageUrl)).andRespond(withSuccess(page(), MediaType.TEXT_HTML))
        server.expect(requestTo(downloadUrl))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().string("atchFileNo=52935&fileOrd=6&fileBtn=A"))
            .andRespond(withSuccess(byteArrayOf(0x50, 0x4b, 0x03, 0x04), MediaType.APPLICATION_OCTET_STREAM))

        val result = client.collect("MSIT", sourceProgramId, pageUrl)

        assertEquals("과기정통부 지원사업", result.programTitle)
        assertEquals(pageUrl, result.sourcePageUrl)
        assertEquals("신청양식.hwpx", result.files.single().fileName)
        assertEquals("HWPX", result.files.single().format)
        assertArrayEquals(byteArrayOf(0x50, 0x4b, 0x03, 0x04), result.files.single().bytes)
        assertTrue(result.warnings.any { it.contains("과기정통부 공식 페이지") })
        server.verify()
    }

    @Test
    fun rejectsMismatchedSourceAndAmbiguousDownloadCalls() {
        assertEquals(
            Reason.INVALID,
            assertThrows(SupportProgramDocumentException::class.java) {
                client.collect("MSIT", "3186574", pageUrl)
            }.reason,
        )
        server.expect(requestTo(pageUrl)).andRespond(withSuccess(page("""
            <a onclick="fn_download('52935', '6', 'hwpx');">다운로드</a>
        """), MediaType.TEXT_HTML))
        assertEquals(
            Reason.INVALID,
            assertThrows(SupportProgramDocumentException::class.java) {
                client.collect("MSIT", sourceProgramId, pageUrl)
            }.reason,
        )
        server.verify()
    }

    @Test
    fun collectsHwpAndDoesNotFollowPageRedirects() {
        server.expect(requestTo(pageUrl)).andRespond(withSuccess(page(fileName = "신청양식.hwp", extension = "hwp"), MediaType.TEXT_HTML))
        server.expect(requestTo(downloadUrl)).andRespond(withSuccess(byteArrayOf(1), MediaType.APPLICATION_OCTET_STREAM))
        server.expect(requestTo(pageUrl)).andRespond(withStatus(HttpStatus.FOUND))
        assertEquals("HWP", client.collect("MSIT", sourceProgramId, pageUrl).files.single().format)
        assertEquals(
            Reason.UNAVAILABLE,
            assertThrows(SupportProgramDocumentException::class.java) {
                client.collect("MSIT", sourceProgramId, pageUrl)
            }.reason,
        )
        server.verify()
    }

    private fun page(extraDownload: String = "", fileName: String = "신청양식.hwpx", extension: String = "hwpx") = """
        <div class="board_view">
          <div class="view_head"><h2>과기정통부 지원사업</h2></div>
          <div class="view_file"><ul class="down_file"><li>
            <a title="${extension.uppercase()} 파일 다운로드">$fileName</a>
            <a onclick="fn_download('52935', '6', '$extension');">다운로드</a>
            $extraDownload
          </li></ul></div>
        </div>
    """.trimIndent()
}
