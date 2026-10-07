package ai.govbiz.core.supportprogram.client.bizinfo

import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachmentLink
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito.`when`
import org.mockito.Mockito.mock
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class BizInfoAttachmentClientLinksTest {
    private val builder = RestClient.builder()
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val html = mock(BizInfoSourceDocumentClient::class.java)
    private val client = BizInfoAttachmentClient(html, builder.build())
    private val pageUrl = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_1"

    private fun download(index: Int) = "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_${index + 1}&fileSn=$index"

    @Test
    fun listsEveryOfficialFileExceptImagesWithoutDownloadingThem() {
        `when`(html.fetchHtml(pageUrl, "PBLN_1")).thenReturn("""
            <div class="support_project_detail"><div class="title_area"><span class="title">검증 공고</span></div><ul>
              <h3>첨부파일</h3>
              <li><div class="file_name">신청서.hwp [141.87 KB]</div><a href="${download(0)}">다운로드</a></li>
              <li><div class="file_name">서식 묶음.zip</div><a href="${download(1)}">다운로드</a></li>
              <li><div class="file_name">홍보 포스터.JPG</div><a href="${download(2)}">다운로드</a></li>
              <li><div class="file_name">위조.hwp</div><a href="https://evil.example/cmm/fms/fileDown.do?atchFileId=FILE_9&amp;fileSn=0">다운로드</a></li>
              <h3>본문출력파일</h3>
              <li><div class="file_name">공고문.pdf</div><a href="${download(3)}">다운로드</a></li>
            </ul></div>
        """.trimIndent())

        val links = client.links("PBLN_1")

        assertEquals(listOf("신청서.hwp" to "hwp", "서식 묶음.zip" to "zip", "공고문.pdf" to "pdf"), links.map { it.fileName to it.extension })
        assertEquals(listOf(download(0), download(1), download(3)), links.map { it.url })
        server.verify()
    }

    @Test
    fun streamsOnlyTrustedFilesAndRejectsHtmlErrorPages() {
        val link = SupportProgramAttachmentLink("신청서.hwp", "hwp", download(0))
        server.expect(requestTo(download(0))).andRespond(withSuccess(byteArrayOf(1, 2, 3), MediaType.APPLICATION_OCTET_STREAM))
        server.expect(requestTo(download(0))).andRespond(withSuccess("<html>파일이 없습니다</html>", MediaType.TEXT_HTML))

        var received = byteArrayOf()
        client.open(link) { _, body -> received = body.readAllBytes() }

        assertArrayEquals(byteArrayOf(1, 2, 3), received)
        assertEquals(Reason.UNAVAILABLE, assertThrows(SupportProgramDocumentException::class.java) { client.open(link) { _, _ -> } }.reason)
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) {
            client.open(link.copy(url = "https://evil.example/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=0")) { _, _ -> }
        }.reason)
        server.verify()
    }
}
