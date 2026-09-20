package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.kstartup.KStartupClient
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupClientException
import ai.govbiz.core.supportprogram.client.kstartup.mapper.KStartupProgramMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramCatalogFacadeException
import java.time.Clock
import java.time.LocalDate
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Component

@Component("kStartupSupportProgramCatalogFacade")
class KStartupSupportProgramCatalogFacade(
    private val client: KStartupClient,
    @param:Qualifier("seoulClock") private val clock: Clock,
) : SupportProgramCatalogFacade {
    override fun load(): List<CatalogSupportProgram> =
        try {
            KStartupProgramMapper.mapValidated(client.fetchAll(), LocalDate.now(clock))
        } catch (exception: KStartupClientException) {
            throw SupportProgramCatalogFacadeException.fromClient(
                failure = when (exception.failure) {
                    KStartupClientException.Failure.NOT_CONFIGURED -> SupportProgramCatalogFacadeException.Failure.NOT_CONFIGURED
                    KStartupClientException.Failure.UPSTREAM_ERROR -> SupportProgramCatalogFacadeException.Failure.UPSTREAM_ERROR
                    KStartupClientException.Failure.INVALID_RESPONSE -> SupportProgramCatalogFacadeException.Failure.INVALID_RESPONSE
                    KStartupClientException.Failure.UNAVAILABLE -> SupportProgramCatalogFacadeException.Failure.UNAVAILABLE
                    KStartupClientException.Failure.TIMEOUT -> SupportProgramCatalogFacadeException.Failure.TIMEOUT
                },
                message = exception.message, cause = exception,
            )
        }
}
