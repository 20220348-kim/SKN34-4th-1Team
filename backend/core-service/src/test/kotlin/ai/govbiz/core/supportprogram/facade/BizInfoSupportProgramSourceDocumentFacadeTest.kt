package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoSourceDocumentClient
import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoSourceDocumentClientException
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramSourceDocumentFacadeException
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.reset
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class BizInfoSupportProgramSourceDocumentFacadeTest {

    @Mock
    private lateinit var client: BizInfoSourceDocumentClient

    private val program = catalogProgram("PBLN_1").program

    @Test
    fun loadsTheOfficialHtmlAsASourceDocumentAtTheSeoulClockTime() {
        doReturn(VALID_HTML).`when`(client).fetchHtml(program.sourceUrl, program.id)

        val document = facade().load(program)

        assertEquals("BIZINFO:PBLN_1", document.sourceQualifiedId)
        assertEquals(LocalDateTime.of(2026, 9, 5, 10, 30), document.fetchedAt)
        assertEquals(program.sourceUrl, document.sourceUrl)
        verify(client).fetchHtml(program.sourceUrl, program.id)
    }

    @Test
    fun hidesProviderSpecificClientFailuresBehindStableFacadeFailures() {
        val cases = listOf(
            failureCase(
                BizInfoSourceDocumentClientException.upstreamError("upstream detail", IllegalStateException()),
                SupportProgramSourceDocumentFacadeException.Failure.UPSTREAM_ERROR,
            ),
            failureCase(
                BizInfoSourceDocumentClientException.invalidResponse("invalid detail", IllegalArgumentException()),
                SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE,
            ),
            failureCase(
                BizInfoSourceDocumentClientException.unavailable(IllegalStateException()),
                SupportProgramSourceDocumentFacadeException.Failure.UNAVAILABLE,
            ),
            failureCase(
                BizInfoSourceDocumentClientException.timeout(IllegalStateException()),
                SupportProgramSourceDocumentFacadeException.Failure.TIMEOUT,
            ),
        )

        cases.forEach { case ->
            doThrow(case.clientException).`when`(client).fetchHtml(program.sourceUrl, program.id)

            val exception = assertThrows(SupportProgramSourceDocumentFacadeException::class.java) {
                facade().load(program)
            }

            assertEquals(case.expectedFailure, exception.failure)
            assertSame(case.clientException, exception.cause)
            verify(client).fetchHtml(program.sourceUrl, program.id)
            reset(client)
        }
    }

    @Test
    fun mapsUnreadableHtmlToAnInvalidSourceDocumentFacadeFailure() {
        doReturn("<html><body><main>너무 짧은 원문</main></body></html>")
            .`when`(client).fetchHtml(program.sourceUrl, program.id)

        val exception = assertThrows(SupportProgramSourceDocumentFacadeException::class.java) {
            facade().load(program)
        }

        assertEquals(SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE, exception.failure)
        verify(client).fetchHtml(program.sourceUrl, program.id)
    }

    private fun facade() = BizInfoSupportProgramSourceDocumentFacade(client, SEOUL_CLOCK)

    private fun failureCase(
        clientException: BizInfoSourceDocumentClientException,
        expectedFailure: SupportProgramSourceDocumentFacadeException.Failure,
    ) = FailureCase(clientException, expectedFailure)

    private data class FailureCase(
        val clientException: BizInfoSourceDocumentClientException,
        val expectedFailure: SupportProgramSourceDocumentFacadeException.Failure,
    )

    private companion object {
        val SEOUL_CLOCK: Clock = Clock.fixed(
            Instant.parse("2026-09-05T01:30:00Z"),
            ZoneId.of("Asia/Seoul"),
        )
        const val VALID_HTML =
            "<div class='support_project_detail'><div class='title_area'><h2 class='title'>PBLN_1 지원사업</h2></div><div class='view_cont'>서울 AI 기업은 기술 개발과 사업화를 위한 자금 및 컨설팅 지원을 받을 수 있으며, 신청 기업은 접수 기간 안에 사업계획서와 필수 증빙 서류를 온라인으로 제출해야 합니다. 선정 결과와 후속 절차는 별도 안내됩니다.</div></div>"
    }
}
