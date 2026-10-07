package ai.govbiz.core.supportprogram.client.kstartup

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class KStartupAttachmentClientLinksTest {
    private val builder = RestClient.builder()
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = KStartupAttachmentClient(builder.build())
    private val id = "177911"
    private val current = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$id&schM=view"

    @Test
    fun listsFilesWithTheirDetailPageAsRefererAndStreamsTheChosenOne() {
        server.expect(requestTo(current)).andRespond(withSuccess("""
            <div class="title" id="scrTitle"><h3>K-Startup 공식 공고</h3></div>
            <div class="board_file"><ul>
              <li><a class="file_bg">[첨부파일] 서식1. 사업계획서.hwp</a><a href="/afile/fileDownload/YV1Ln" class="btn_down" name="downloadBtn">다운로드</a></li>
              <li><a class="file_bg">[첨부파일] 홍보.jpg</a><a href="/afile/fileDownload/Img01" class="btn_down" name="downloadBtn">다운로드</a></li>
              <li><a class="file_bg">[첨부파일] 서식 모음.zip</a><a href="/afile/fileDownload/Zip01" class="btn_down" name="downloadBtn">다운로드</a></li>
              <li><a class="file_bg">버튼 없는 파일.pdf</a></li>
            </ul></div>
        """.trimIndent(), MediaType.TEXT_HTML))
        server.expect(requestTo("https://www.k-startup.go.kr/afile/fileDownload/YV1Ln")).andExpect(header(HttpHeaders.REFERER, current))
            .andRespond(withSuccess(byteArrayOf(7, 8), MediaType.APPLICATION_OCTET_STREAM))

        val links = client.links(id, current)
        var received = byteArrayOf()
        client.open(links.first()) { _, body -> received = body.readAllBytes() }

        assertEquals(listOf("[첨부파일] 서식1. 사업계획서.hwp", "[첨부파일] 서식 모음.zip"), links.map { it.fileName })
        assertEquals(listOf(current, current), links.map { it.referer })
        assertArrayEquals(byteArrayOf(7, 8), received)
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) {
            client.open(links.first().copy(referer = "https://attacker.test/page")) { _, _ -> }
        }.reason)
        server.verify()
    }
}
