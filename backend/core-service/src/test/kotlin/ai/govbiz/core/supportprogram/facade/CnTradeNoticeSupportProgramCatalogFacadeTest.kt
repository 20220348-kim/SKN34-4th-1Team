package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeClient
import ai.govbiz.core.supportprogram.client.cntradenotice.dto.CnTradeNoticeProgramPayload
import ai.govbiz.core.supportprogram.client.cntradenotice.exception.CnTradeNoticeClientException
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
class CnTradeNoticeSupportProgramCatalogFacadeTest {
    @Mock private lateinit var client: CnTradeNoticeClient

    @Test
    fun validatesAndMapsTheEntireResponseWithoutInferringEligibility() {
        doReturn(listOf(payload())).`when`(client).fetchAll()
        val program = CnTradeNoticeSupportProgramCatalogFacade(client).load().single().program
        assertEquals("CNTRADE_NOTICE", program.sourceCode)
        assertEquals(SupportProgramStatus.UNKNOWN, program.status)
        verify(client).fetchAll()
    }

    @Test
    fun translatesClientFailuresWithoutChangingTheirFailureCategory() {
        val failures = listOf(CnTradeNoticeClientException.notConfigured(), CnTradeNoticeClientException.upstreamError(503),
            CnTradeNoticeClientException.invalidResponse("invalid"), CnTradeNoticeClientException.unavailable(),
            CnTradeNoticeClientException.timeout())
        for (failure in failures) {
            doThrow(failure).`when`(client).fetchAll()
            val error = assertThrows(SupportProgramCatalogFacadeException::class.java) {
                CnTradeNoticeSupportProgramCatalogFacade(client).load()
            }
            assertEquals(failure.failure.name, error.failure.name)
            assertSame(failure, error.cause)
        }
    }

    @Test
    fun wrapsMappingFailuresWithoutReturningPartiallyValidNotices() {
        doReturn(listOf(payload(), payload().copy(id = "2", title = null))).`when`(client).fetchAll()
        val error = assertThrows(SupportProgramCatalogFacadeException::class.java) {
            CnTradeNoticeSupportProgramCatalogFacade(client).load()
        }
        assertEquals(SupportProgramCatalogFacadeException.Failure.INVALID_RESPONSE, error.failure)
    }

    private fun payload() = CnTradeNoticeProgramPayload("3862", "수출 공지", "기관", "원문 조건", "2021-10-22", null)
}
