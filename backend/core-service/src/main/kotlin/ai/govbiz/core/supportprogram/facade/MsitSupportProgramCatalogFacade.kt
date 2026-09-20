package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.msit.MsitClient
import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
import ai.govbiz.core.supportprogram.client.msit.mapper.MsitProgramMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramCatalogFacadeException
import org.springframework.stereotype.Component

@Component("msitSupportProgramCatalogFacade")
class MsitSupportProgramCatalogFacade(private val client: MsitClient) : SupportProgramCatalogFacade {
    override fun load(): List<CatalogSupportProgram> =
        try {
            MsitProgramMapper.mapValidated(client.fetchAll())
        } catch (exception: MsitClientException) {
            throw SupportProgramCatalogFacadeException.fromClient(
                failure = when (exception.failure) {
                    MsitClientException.Failure.NOT_CONFIGURED -> SupportProgramCatalogFacadeException.Failure.NOT_CONFIGURED
                    MsitClientException.Failure.UPSTREAM_ERROR -> SupportProgramCatalogFacadeException.Failure.UPSTREAM_ERROR
                    MsitClientException.Failure.INVALID_RESPONSE -> SupportProgramCatalogFacadeException.Failure.INVALID_RESPONSE
                    MsitClientException.Failure.UNAVAILABLE -> SupportProgramCatalogFacadeException.Failure.UNAVAILABLE
                    MsitClientException.Failure.TIMEOUT -> SupportProgramCatalogFacadeException.Failure.TIMEOUT
                },
                message = exception.message, cause = exception,
            )
        }
}
