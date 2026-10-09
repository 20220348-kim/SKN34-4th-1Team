package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoSourceDocumentClient
import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoSourceDocumentClientException
import ai.govbiz.core.supportprogram.client.kstartup.KStartupSourceDocumentClient
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupSourceDocumentClientException
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramSourceDocumentFacadeException
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.reset
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class SupportProgramSourceDocumentFacadeTest {

    @Mock
    private lateinit var bizInfoClient: BizInfoSourceDocumentClient

    @Mock
    private lateinit var kStartupClient: KStartupSourceDocumentClient

    private val program = catalogProgram("PBLN_1").program
    private val kStartupProgram = program.copy(
        id = "178927",
        sourceCode = "KSTARTUP",
        title = "2026 K-Startup 'IR' 데모데이 참가기업 모집",
        sourceName = "K-Startup",
        sourceUrl = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178927",
    )

    @Test
    fun loadsTheOfficialHtmlAsASourceDocumentAtTheSeoulClockTime() {
        doReturn(VALID_HTML).`when`(bizInfoClient).fetchHtml(program.sourceUrl, program.id)

        val document = facade().load(program)

        assertEquals("BIZINFO:PBLN_1", document.sourceQualifiedId)
        assertEquals(LocalDateTime.of(2026, 9, 5, 10, 30), document.fetchedAt)
        assertEquals(program.sourceUrl, document.sourceUrl)
        verify(bizInfoClient).fetchHtml(program.sourceUrl, program.id)
        verifyNoInteractions(kStartupClient)
    }

    @Test
    fun loadsKStartupProgramsThroughTheKStartupClientAndKeepsTheProgramSourceUrl() {
        doReturn(VALID_KSTARTUP_HTML).`when`(kStartupClient).fetchHtml(kStartupProgram.sourceUrl, kStartupProgram.id)

        val document = facade().load(kStartupProgram)

        assertEquals("KSTARTUP:178927", document.sourceQualifiedId)
        assertEquals(LocalDateTime.of(2026, 9, 5, 10, 30), document.fetchedAt)
        assertEquals(kStartupProgram.sourceUrl, document.sourceUrl)
        assertTrue(document.content.contains("제출서류"))
        verify(kStartupClient).fetchHtml(kStartupProgram.sourceUrl, kStartupProgram.id)
        verifyNoInteractions(bizInfoClient)
    }

    @Test
    fun refusesSourcesWithoutAnOfficialDetailDocumentBeforeCallingAnyClient() {
        assertThrows(IllegalStateException::class.java) {
            facade().load(program.copy(sourceCode = "MSIT", sourceUrl = "https://www.msit.go.kr/bbs/view.do?nttSeqNo=1"))
        }
        verifyNoInteractions(bizInfoClient, kStartupClient)
    }

    @Test
    fun hidesProviderSpecificClientFailuresBehindStableFacadeFailures() {
        val cases = listOf(
            BizInfoSourceDocumentClientException.upstreamError("upstream detail", IllegalStateException()) to
                SupportProgramSourceDocumentFacadeException.Failure.UPSTREAM_ERROR,
            BizInfoSourceDocumentClientException.invalidResponse("invalid detail", IllegalArgumentException()) to
                SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE,
            BizInfoSourceDocumentClientException.unavailable(IllegalStateException()) to
                SupportProgramSourceDocumentFacadeException.Failure.UNAVAILABLE,
            BizInfoSourceDocumentClientException.timeout(IllegalStateException()) to
                SupportProgramSourceDocumentFacadeException.Failure.TIMEOUT,
        )

        cases.forEach { (clientException, expectedFailure) ->
            doThrow(clientException).`when`(bizInfoClient).fetchHtml(program.sourceUrl, program.id)

            val exception = assertThrows(SupportProgramSourceDocumentFacadeException::class.java) {
                facade().load(program)
            }

            assertEquals(expectedFailure, exception.failure)
            assertSame(clientException, exception.cause)
            verify(bizInfoClient).fetchHtml(program.sourceUrl, program.id)
            reset(bizInfoClient)
        }
    }

    @Test
    fun hidesKStartupClientFailuresBehindTheSameStableFacadeFailures() {
        val cases = listOf(
            KStartupSourceDocumentClientException.upstreamError("returned HTTP 404", null) to
                SupportProgramSourceDocumentFacadeException.Failure.UPSTREAM_ERROR,
            KStartupSourceDocumentClientException.invalidResponse("not html", null) to
                SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE,
            KStartupSourceDocumentClientException.unavailable(IllegalStateException()) to
                SupportProgramSourceDocumentFacadeException.Failure.UNAVAILABLE,
            KStartupSourceDocumentClientException.timeout(IllegalStateException()) to
                SupportProgramSourceDocumentFacadeException.Failure.TIMEOUT,
        )

        cases.forEach { (clientException, expectedFailure) ->
            doThrow(clientException).`when`(kStartupClient).fetchHtml(kStartupProgram.sourceUrl, kStartupProgram.id)

            val exception = assertThrows(SupportProgramSourceDocumentFacadeException::class.java) {
                facade().load(kStartupProgram)
            }

            assertEquals(expectedFailure, exception.failure)
            assertSame(clientException, exception.cause)
            reset(kStartupClient)
        }
    }

    @Test
    fun mapsUnreadableHtmlToAnInvalidSourceDocumentFacadeFailure() {
        doReturn("<html><body><main>너무 짧은 원문</main></body></html>")
            .`when`(bizInfoClient).fetchHtml(program.sourceUrl, program.id)
        doReturn("<div class='app_notice_details-wrap'><div id='scrTitle'><h3>다른 공고</h3></div></div>")
            .`when`(kStartupClient).fetchHtml(kStartupProgram.sourceUrl, kStartupProgram.id)

        listOf(program, kStartupProgram).forEach { target ->
            val exception = assertThrows(SupportProgramSourceDocumentFacadeException::class.java) {
                facade().load(target)
            }
            assertEquals(SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE, exception.failure)
        }
        verify(bizInfoClient).fetchHtml(program.sourceUrl, program.id)
        verify(kStartupClient).fetchHtml(kStartupProgram.sourceUrl, kStartupProgram.id)
    }

    private fun facade() = SupportProgramSourceDocumentFacade(bizInfoClient, kStartupClient, SEOUL_CLOCK)

    private companion object {
        val SEOUL_CLOCK: Clock = Clock.fixed(
            Instant.parse("2026-09-05T01:30:00Z"),
            ZoneId.of("Asia/Seoul"),
        )
        const val VALID_HTML =
            "<div class='support_project_detail'><div class='title_area'><h2 class='title'>PBLN_1 지원사업</h2></div><div class='view_cont'>서울 AI 기업은 기술 개발과 사업화를 위한 자금 및 컨설팅 지원을 받을 수 있으며, 신청 기업은 접수 기간 안에 사업계획서와 필수 증빙 서류를 온라인으로 제출해야 합니다. 선정 결과와 후속 절차는 별도 안내됩니다.</div></div>"
        const val VALID_KSTARTUP_HTML =
            "<div class='app_notice_details-wrap'><div class='title' id='scrTitle'><h3>2026 K-Startup \"IR\" 데모데이 참가기업 모집</h3></div><div class='information_list'><p class='title'>제출서류</p><p class='list'>참가신청서 1부와 발표자료 1부를 하나의 압축파일로 묶어 이메일로 제출합니다. 서면평가 후 본선 진출 기업에 개별 안내합니다.</p></div></div>"
    }
}
