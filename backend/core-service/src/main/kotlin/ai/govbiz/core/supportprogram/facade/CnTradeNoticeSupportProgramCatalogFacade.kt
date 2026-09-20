package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeClient
import ai.govbiz.core.supportprogram.client.cntradenotice.exception.CnTradeNoticeClientException
import ai.govbiz.core.supportprogram.client.cntradenotice.mapper.CnTradeNoticeProgramMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramCatalogFacadeException
import org.springframework.stereotype.Component

@Component("cnTradeNoticeSupportProgramCatalogFacade")
class CnTradeNoticeSupportProgramCatalogFacade(
    private val client: CnTradeNoticeClient,
) : SupportProgramCatalogFacade {
    override fun load(): List<CatalogSupportProgram> =
        try {
            CnTradeNoticeProgramMapper.mapValidated(client.fetchAll())
        } catch (exception: CnTradeNoticeClientException) {
            throw SupportProgramCatalogFacadeException.fromClient(
                failure = when (exception.failure) {
                    CnTradeNoticeClientException.Failure.NOT_CONFIGURED -> SupportProgramCatalogFacadeException.Failure.NOT_CONFIGURED
                    CnTradeNoticeClientException.Failure.UPSTREAM_ERROR -> SupportProgramCatalogFacadeException.Failure.UPSTREAM_ERROR
                    CnTradeNoticeClientException.Failure.INVALID_RESPONSE -> SupportProgramCatalogFacadeException.Failure.INVALID_RESPONSE
                    CnTradeNoticeClientException.Failure.UNAVAILABLE -> SupportProgramCatalogFacadeException.Failure.UNAVAILABLE
                    CnTradeNoticeClientException.Failure.TIMEOUT -> SupportProgramCatalogFacadeException.Failure.TIMEOUT
                },
                message = exception.message, cause = exception,
            )
        }
}
