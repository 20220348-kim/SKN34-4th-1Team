package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.msit.MsitClient
import ai.govbiz.core.supportprogram.client.msit.dto.MsitProgramPayload
import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramCatalogFacadeException
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
class MsitSupportProgramCatalogFacadeTest {
    @Mock private lateinit var client: MsitClient

    @Test
    fun mapsTheCompleteOfficialResponseWithoutInventingAnApplicationPeriod() {
        doReturn(listOf(payload())).`when`(client).fetchAll()
        val result = MsitSupportProgramCatalogFacade(client).load().single()
        assertEquals("MSIT", result.program.sourceCode)
        assertEquals(SupportProgramStatus.UNKNOWN, result.program.status)
        assertEquals("2026-09-09", result.sortTimestamp)
        verify(client).fetchAll()
    }

    @Test
    fun translatesEveryClientFailureWithoutChangingItsCategory() {
        val failures = listOf(
            MsitClientException.notConfigured(), MsitClientException.upstreamError(503),
            MsitClientException.invalidResponse("invalid"), MsitClientException.unavailable(), MsitClientException.timeout(),
        )
        failures.forEach { failure ->
            doThrow(failure).`when`(client).fetchAll()
            val error = assertThrows(SupportProgramCatalogFacadeException::class.java) { MsitSupportProgramCatalogFacade(client).load() }
            assertEquals(failure.failure.name, error.failure.name)
            assertSame(failure, error.cause)
        }
    }

    @Test
    fun mappingFailureCannotPublishAPartialSnapshot() {
        doReturn(listOf(payload(), payload().copy(title = null))).`when`(client).fetchAll()
        val failure = assertThrows(SupportProgramCatalogFacadeException::class.java) { MsitSupportProgramCatalogFacade(client).load() }
        assertEquals(SupportProgramCatalogFacadeException.Failure.INVALID_RESPONSE, failure.failure)
    }

    private fun payload() = MsitProgramPayload(
        title = "사업 공고", organization = "과학기술정보통신부", publishedAt = "2026-09-09",
        sourceUrl = "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=3186878",
    )
}
