package ai.govbiz.core.supportprogram.client.kstartup

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import java.net.URI
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class KStartupAttachmentClientTest {
    private val builder = RestClient.builder()
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = KStartupAttachmentClient(builder.build())
    private val id = "177911"
    private val current = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$id&schM=view"
    private val closed = "https://www.k-startup.go.kr/web/contents/bizpbanc-deadline.do?pbancSn=$id&schM=view"
    private val download = "https://www.k-startup.go.kr/afile/fileDownload/osbLn"

    @Test
    fun followsTheVerifiedStatusPageAndCollectsOfficialHwp() {
        server.expect(requestTo(current)).andRespond(withSuccess(
            "<script>var fullUrl = '/web/contents/bizpbanc-deadline.do?pbancSn=$id&schM=view';</script>",
            MediaType.TEXT_HTML,
        ))
        server.expect(requestTo(closed)).andRespond(withSuccess(detail(), MediaType.TEXT_HTML))
        server.expect(requestTo(download)).andExpect(header(HttpHeaders.REFERER, closed))
            .andRespond(withSuccess(byteArrayOf(1, 2, 3), MediaType.APPLICATION_OCTET_STREAM))

        val result = client.collect("KSTARTUP", id, current)

        assertEquals("K-Startup 공식 공고", result.programTitle)
        assertEquals(closed, result.sourcePageUrl)
        assertEquals("신청양식.hwp", result.files.single().fileName)
        assertEquals("HWP", result.files.single().format)
        assertArrayEquals(byteArrayOf(1, 2, 3), result.files.single().bytes)
        assertTrue(result.warnings.single().contains("K-Startup 공식 페이지"))
        server.verify()
    }

    @Test
    fun rejectsAnUntrustedDetailOrDownloadWithoutFollowingIt() {
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) {
            client.collect("KSTARTUP", id, "https://attacker.test/detail?pbancSn=$id")
        }.reason)
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) {
            client.requireDownloadUri(URI("https://www.k-startup.go.kr/afile/fileDownload/../secret"))
        }.reason)
    }

    @Test
    fun rejectsRedirectsAndPagesWithoutSupportedAttachments() {
        server.expect(requestTo(current)).andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, "https://attacker.test"))
        server.expect(requestTo(current)).andRespond(withSuccess(
            "<div id='scrTitle'><h3>공고</h3></div><div class='board_file'><li><a class='file_bg'>이미지.jpg</a></li></div>",
            MediaType.TEXT_HTML,
        ))
        assertEquals(Reason.UNAVAILABLE, assertThrows(SupportProgramDocumentException::class.java) {
            client.collect("KSTARTUP", id, current)
        }.reason)
        assertEquals(Reason.UNSUPPORTED, assertThrows(SupportProgramDocumentException::class.java) {
            client.collect("KSTARTUP", id, current)
        }.reason)
        server.verify()
    }

    private fun detail() = """
        <div class="title" id="scrTitle"><h3>K-Startup 공식 공고</h3></div>
        <div class="board_file"><ul><li>
          <a class="file_bg">신청양식.hwp</a>
          <a href="/afile/fileDownload/osbLn" class="btn_down" name="downloadBtn">다운로드</a>
        </li></ul></div>
    """.trimIndent()
}
