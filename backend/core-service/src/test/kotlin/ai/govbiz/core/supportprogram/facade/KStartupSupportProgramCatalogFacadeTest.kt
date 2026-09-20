package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.kstartup.KStartupClient
import ai.govbiz.core.supportprogram.client.kstartup.dto.KStartupProgramPayload
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupClientException
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramCatalogFacadeException
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class KStartupSupportProgramCatalogFacadeTest {
    @Mock private lateinit var client: KStartupClient

    @Test
    fun validatesAndMapsTheCompleteClientResponseUsingTheSeoulClock() {
        doReturn(listOf(payload())).`when`(client).fetchAll()
        val program = facade().load().single()
        assertEquals("KSTARTUP", program.program.sourceCode)
        assertEquals(SupportProgramStatus.CLOSED, program.program.status)
        assertEquals(listOf("예비창업자"), program.startupDetails!!.startupStages)
        verify(client).fetchAll()
    }

    @Test
    fun translatesClientFailuresWithoutChangingTheirFailureCategory() {
        val failures = listOf(
            KStartupClientException.notConfigured(), KStartupClientException.upstreamError(503),
            KStartupClientException.invalidResponse("invalid"), KStartupClientException.unavailable(),
            KStartupClientException.timeout(),
        )
        failures.forEach { failure ->
            doThrow(failure).`when`(client).fetchAll()
            val error = assertThrows(SupportProgramCatalogFacadeException::class.java) { facade().load() }
            assertEquals(failure.failure.name, error.failure.name)
            assertSame(failure, error.cause)
        }
    }

    @Test
    fun wrapsValidationFailuresAndDoesNotReturnPartialMappedPrograms() {
        doReturn(listOf(payload(), payload().copy(title = null))).`when`(client).fetchAll()
        val failure = assertThrows(SupportProgramCatalogFacadeException::class.java) { facade().load() }
        assertEquals(SupportProgramCatalogFacadeException.Failure.INVALID_RESPONSE, failure.failure)
    }

    private fun facade() = KStartupSupportProgramCatalogFacade(
        client, Clock.fixed(Instant.parse("2026-09-08T15:00:00Z"), ZoneId.of("Asia/Seoul")),
    )

    private fun payload() = KStartupProgramPayload(
        id = "179197", title = "창업 공고", organization = "기관", summaryHtml = "지원 내용", target = "예비창업자",
        excludedTarget = null, applicantTypes = "일반인", startupStages = "예비창업자", founderAges = null,
        category = "사업화", region = "전국", applicationStartDate = "20260901", applicationEndDate = "20260908",
        sourceUrl = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=179197",
    )
}
