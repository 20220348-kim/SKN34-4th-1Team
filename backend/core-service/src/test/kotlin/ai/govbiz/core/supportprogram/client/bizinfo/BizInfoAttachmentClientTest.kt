package ai.govbiz.core.supportprogram.client.bizinfo

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES
import java.net.URI
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.*
import org.springframework.web.client.RestClient

class BizInfoAttachmentClientTest {
    private val builder = RestClient.builder()
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val html = mock(BizInfoSourceDocumentClient::class.java)
    private val client = BizInfoAttachmentClient(html, builder.build())
    private val sourceProgramId = "PBLN_1"
    private val pageUrl = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_1"
    private val download = download(0)

    private fun download(index: Int) = "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_${index + 1}&fileSn=$index"
    private fun page(extra: String = "", downloads: List<String> = listOf(download)) = """
        <div class="support_project_detail"><div class="title_area"><span class="title">검증 공고</span></div>
        ${downloads.mapIndexed { index, url ->
            val name = if (downloads.size == 1) "공고문.pdf" else "공고문-${index + 1}.pdf"
            "<li><div class=\"file_name\">$name</div><a href=\"$url\">다운로드</a></li>"
        }.joinToString("")}$extra</div><a href="https://evil.example/tracker.pdf">footer</a>
    """.trimIndent()
    private fun stubPage(text: String) { `when`(html.fetchHtml(pageUrl, sourceProgramId)).thenReturn(text) }

    @Test
    fun collectsOnlyLinkedFilesInsideTheOfficialDetail() {
        stubPage(page())
        server.expect(requestTo(download)).andRespond(withSuccess(byteArrayOf(1,2,3), MediaType.APPLICATION_PDF))
        val result = client.collect("BIZINFO", sourceProgramId)
        assertEquals("검증 공고", result.programTitle)
        assertEquals(pageUrl, result.sourcePageUrl)
        assertEquals(1, result.files.size)
        assertArrayEquals(byteArrayOf(1,2,3), result.files.single().bytes)
        assertTrue(result.warnings.isNotEmpty())
        server.verify()
    }

    @Test
    fun collectsNativeXlsxFromTheOfficialDetail() {
        stubPage(page().replace("공고문.pdf", "신청서.xlsx"))
        server.expect(requestTo(download)).andRespond(withSuccess(byteArrayOf(1,2,3), MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")))
        val result = client.collect("BIZINFO", sourceProgramId)
        assertEquals("검증 공고", result.programTitle)
        assertEquals(pageUrl, result.sourcePageUrl)
        assertEquals(1, result.files.size)
        assertEquals("XLSX", result.files.single().format)
        assertArrayEquals(byteArrayOf(1,2,3), result.files.single().bytes)
        assertTrue(result.warnings.isNotEmpty())
        server.verify()
    }

    @Test
    fun prefersPublisherHwpxOverTheSameTitlePdfAndRecordsThatChoice() {
        val mss = "https://www.mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=123&cbIdx=310&parentSeq=123"
        val file = "https://www.mss.go.kr/common/board/Download.do?bcIdx=123&cbIdx=310&streFileNm=abc.hwpx"
        stubPage(page("""<a href="$mss">출처 바로가기</a>"""))
        server.expect(requestTo(mss)).andRespond(withSuccess("""<div class="board_view"><div><span class="name">공고문.hwpx [12 KB]</span><div><a href="$file">다운로드</a></div></div></div>""", MediaType.TEXT_HTML))
        server.expect(requestTo(file)).andRespond(withSuccess(byteArrayOf(1), MediaType.APPLICATION_OCTET_STREAM))
        val result = client.collect("BIZINFO", sourceProgramId)
        assertEquals("HWPX", result.files.single().format)
        assertTrue(result.warnings.any { it.contains("발행기관 중기부 HWPX") })
        server.verify()
    }

    private fun sectionedPage(attachments: List<Pair<String, String>>, bodyExports: List<Pair<String, String>> = emptyList()): String {
        fun items(files: List<Pair<String, String>>) = files.joinToString("") { (name, url) ->
            "<li><div class=\"file_name\">$name</div><div class=\"right_btn\"><a href=\"$url\">다운로드</a></div></li>"
        }
        return """<div class="support_project_detail"><div class="title_area"><span class="title">검증 공고</span></div>
            <div class="attached_file_list"><ul><h3>첨부파일</h3>${items(attachments)}<h3>본문출력파일</h3>${items(bodyExports)}</ul></div></div>"""
    }

    @Test
    fun bodyExportDoesNotCountTowardTheAttachmentCapAndTheSameFileIsKeptOnce() {
        val attachments = (0 until 8).map { "붙임$it 서식.hwp" to download(it) }
        val bodyExport = "공고 본문.hwp" to download(8)
        stubPage(sectionedPage(attachments, listOf(bodyExport)))
        attachments.forEachIndexed { index, (_, url) ->
            server.expect(requestTo(url)).andRespond(withSuccess(byteArrayOf(index.toByte()), MediaType.APPLICATION_OCTET_STREAM))
        }
        // 본문출력파일이 첨부 0과 같은 파일이면 한 번만 남깁니다.
        server.expect(requestTo(bodyExport.second)).andRespond(withSuccess(byteArrayOf(0), MediaType.APPLICATION_OCTET_STREAM))

        val result = client.collect("BIZINFO", sourceProgramId)

        assertEquals(attachments.map { it.second }, result.files.map { it.sourceUrl })
        assertTrue(result.warnings.any { it.contains("같은 파일이 두 번 연결되어") && it.contains("공고 본문.hwp") })
        server.verify()
    }

    @Test
    fun attachmentsBeyondTheCapAreSkippedWithAWarningInsteadOfFailing() {
        val attachments = (0 until 9).map { "붙임$it 서식.hwp" to download(it) }
        stubPage(sectionedPage(attachments))
        attachments.take(8).forEachIndexed { index, (_, url) ->
            server.expect(requestTo(url)).andRespond(withSuccess(byteArrayOf(index.toByte()), MediaType.APPLICATION_OCTET_STREAM))
        }

        val result = client.collect("BIZINFO", sourceProgramId)

        assertEquals(8, result.files.size)
        assertTrue(result.warnings.any { it.contains("8개를 넘어 받지 않은 첨부") && it.contains("붙임8 서식.hwp") })
        server.verify()
    }

    @Test
    fun sameTitleInAnotherFormatCountsOnceTowardTheCapAndIsKeptAsAFallbackCopy() {
        val attachments = listOf("신청서.pdf" to download(0), "신청서.hwp [52 KB]" to download(1)) +
            (2 until 9).map { "붙임$it 서식.hwp" to download(it) }
        stubPage(sectionedPage(attachments))
        // 각 문서의 우선 사본(HWP)을 먼저 받고, 다른 형식 사본은 그 뒤에 받습니다.
        server.expect(requestTo(download(1))).andRespond(withSuccess(byteArrayOf(1), MediaType.APPLICATION_OCTET_STREAM))
        (2 until 9).forEach { server.expect(requestTo(download(it))).andRespond(withSuccess(byteArrayOf(it.toByte()), MediaType.APPLICATION_OCTET_STREAM)) }
        server.expect(requestTo(download(0))).andRespond(withSuccess(byteArrayOf(0), MediaType.APPLICATION_PDF))

        val result = client.collect("BIZINFO", sourceProgramId)

        assertEquals(listOf("신청서.hwp") + (2 until 9).map { "붙임$it 서식.hwp" } + "신청서.pdf", result.files.map { it.fileName })
        assertFalse(result.warnings.any { it.contains("넘어 받지 않은") })
        server.verify()
    }

    @Test
    fun anOversizedPreferredCopyFallsBackToTheOtherFormat() {
        stubPage(sectionedPage(listOf("신청서.hwp" to download(0), "신청서.pdf" to download(1))))
        server.expect(requestTo(download(0))).andRespond(withSuccess(byteArrayOf(0), MediaType.APPLICATION_OCTET_STREAM)
            .header(HttpHeaders.CONTENT_LENGTH, (MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1).toString()))
        server.expect(requestTo(download(1))).andRespond(withSuccess(byteArrayOf(1), MediaType.APPLICATION_PDF))

        val result = client.collect("BIZINFO", sourceProgramId)

        assertEquals(listOf("신청서.pdf"), result.files.map { it.fileName })
        assertFalse(result.warnings.any { it.contains("미수집 첨부") })
        server.verify()
    }

    @Test
    fun aProgramWithOnlyUnsupportedAttachmentsExplainsWhatWasNotCollected() {
        stubPage(sectionedPage(listOf("신청서식 모음.zip" to download(0))))

        val error = assertThrows(SupportProgramDocumentException::class.java) { client.collect("BIZINFO", sourceProgramId) }

        assertEquals(Reason.UNSUPPORTED, error.reason)
        assertTrue(error.warnings.any { it.contains("신청서식 모음.zip") })
    }

    @Test
    fun aCollectionFailureKeepsTheWarningsGatheredSoFar() {
        stubPage(sectionedPage(listOf("신청서.hwp" to download(0), "안내.zip" to "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_9&fileSn=9")))
        server.expect(requestTo(download(0))).andRespond(withSuccess(byteArrayOf(0), MediaType.APPLICATION_OCTET_STREAM)
            .header(HttpHeaders.CONTENT_LENGTH, (MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1).toString()))

        val error = assertThrows(SupportProgramDocumentException::class.java) { client.collect("BIZINFO", sourceProgramId) }

        assertEquals(Reason.TOO_LARGE, error.reason)
        assertTrue(error.warnings.any { it.contains("미수집 첨부(파일 크기 제한 초과)") && it.contains("신청서.hwp") })
        assertTrue(error.warnings.any { it.contains("안내.zip") })
        server.verify()
    }

    @Test
    fun rejectsNonOfficialUrlsEncodedTraversalAndDuplicateParameters() {
        for (url in listOf(
            "http://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=0",
            "https://www.bizinfo.go.kr.evil.example/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=0",
            "https://127.0.0.1/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=0",
            "https://user@www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=0",
            "$download&fileSn=1", "$download#x",
            "https://www.mss.go.kr/common/board/Download.do?bcIdx=123&cbIdx=310&streFileNm=..%2Fsecret.hwpx",
        )) assertThrows(SupportProgramDocumentException::class.java) { client.requireTrustedUri(URI(url)) }
    }

    @Test
    fun rejectsRedirectsAndUpstreamFailureWithoutFollowingThem() {
        stubPage(page())
        server.expect(requestTo(download)).andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, "https://evil.example"))
        assertEquals(Reason.UNAVAILABLE, assertThrows(SupportProgramDocumentException::class.java) { client.collect("BIZINFO", sourceProgramId) }.reason)
        server.verify()
    }

    @Test
    fun doesNotReplaceMissingAttachmentsWithHtmlSummary() {
        stubPage("""<div class="support_project_detail"><div class="title_area"><span class="title">공고</span></div><p>허용이라는 요약</p></div>""")
        assertEquals(Reason.UNSUPPORTED, assertThrows(SupportProgramDocumentException::class.java) { client.collect("BIZINFO", sourceProgramId) }.reason)
        verify(html).fetchHtml(pageUrl, sourceProgramId)
    }

    @Test
    fun rejectsUnsupportedProvidersBeforeAnyNetworkCall() {
        assertThrows(SupportProgramDocumentException::class.java) { client.collect("KSTARTUP", "1") }
        assertThrows(SupportProgramDocumentException::class.java) { client.collect("BIZINFO", "invalid") }
        verifyNoInteractions(html)
    }

    @Test
    fun enforcesExactFileBoundaryFromContentLengthBeforeReadingTheBody() {
        stubPage(page())
        server.expect(requestTo(download)).andRespond(withSuccess(ByteArray(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES), MediaType.APPLICATION_PDF)
            .header(HttpHeaders.CONTENT_LENGTH, MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES.toString()))
        server.expect(requestTo(download)).andRespond(withSuccess(byteArrayOf(1), MediaType.APPLICATION_PDF)
            .header(HttpHeaders.CONTENT_LENGTH, (MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1).toString()))
        assertEquals(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES, client.collect("BIZINFO", sourceProgramId).files.single().bytes.size)
        assertEquals(Reason.TOO_LARGE, assertThrows(SupportProgramDocumentException::class.java) { client.collect("BIZINFO", sourceProgramId) }.reason)
        server.verify()
    }

    @Test
    fun enforcesExactFileBoundaryWhileStreamingWithoutContentLength() {
        stubPage(page())
        server.expect(requestTo(download)).andRespond(withSuccess(ByteArray(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES), MediaType.APPLICATION_PDF))
        server.expect(requestTo(download)).andRespond(withSuccess(ByteArray(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1), MediaType.APPLICATION_PDF))
        assertEquals(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES, client.collect("BIZINFO", sourceProgramId).files.single().bytes.size)
        assertEquals(Reason.TOO_LARGE, assertThrows(SupportProgramDocumentException::class.java) { client.collect("BIZINFO", sourceProgramId) }.reason)
        server.verify()
    }

    @Test
    fun skipsOversizedAttachmentWhenAnotherSupportedAttachmentRemains() {
        val downloads = listOf(download(0), download(1))
        stubPage(page(downloads = downloads))
        server.expect(requestTo(downloads[0])).andRespond(withSuccess(byteArrayOf(1), MediaType.APPLICATION_PDF)
            .header(HttpHeaders.CONTENT_LENGTH, (MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1).toString()))
        server.expect(requestTo(downloads[1])).andRespond(withSuccess(byteArrayOf(2), MediaType.APPLICATION_PDF))

        val result = client.collect("BIZINFO", sourceProgramId)

        assertEquals(listOf(downloads[1]), result.files.map { it.sourceUrl })
        assertTrue(result.warnings.any { it.contains("파일 크기 제한 초과") })
        server.verify()
    }

    @Test
    fun enforcesTotalAttachmentBoundaryByKeepingFilesWithinTheLimit() {
        val twoDownloads = listOf(download(0), download(1))
        val threeDownloads = twoDownloads + download(2)
        `when`(html.fetchHtml(pageUrl, sourceProgramId)).thenReturn(
            page(downloads = twoDownloads),
            page(downloads = threeDownloads),
        )
        // 서로 다른 파일이어야 같은 파일 중복 제거에 걸리지 않습니다.
        repeat(2) {
            twoDownloads.forEachIndexed { index, url ->
                server.expect(requestTo(url)).andRespond(withSuccess(ByteArray(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES) { index.toByte() }, MediaType.APPLICATION_PDF))
            }
        }
        server.expect(requestTo(download(2))).andRespond(withSuccess(byteArrayOf(1), MediaType.APPLICATION_PDF))
        assertEquals(MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES, client.collect("BIZINFO", sourceProgramId).files.sumOf { it.bytes.size })
        val limited = client.collect("BIZINFO", sourceProgramId)
        assertEquals(MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES, limited.files.sumOf { it.bytes.size })
        assertTrue(limited.warnings.any { it.contains("공고별 전체 크기 제한 초과") })
        server.verify()
    }
}
