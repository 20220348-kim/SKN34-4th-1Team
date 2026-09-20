package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoClient
import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoClientException
import ai.govbiz.core.supportprogram.client.bizinfo.mapper.BizInfoProgramMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramCatalogFacadeException
import java.time.Clock
import java.time.LocalDate
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Component

/** 기업마당 조회·오류 변환·검색 후보 정규화를 단일 진입점으로 제공합니다. */
@Component
class BizInfoSupportProgramCatalogFacade(
    private val client: BizInfoClient,
    @param:Qualifier("seoulClock") private val clock: Clock,
) : SupportProgramCatalogFacade {

    override fun load(): List<CatalogSupportProgram> =
        try {
            BizInfoProgramMapper.mapValidated(
                payloads = client.fetchAll(),
                today = LocalDate.now(clock),
            )
        } catch (exception: BizInfoClientException) {
            throw SupportProgramCatalogFacadeException.fromClient(
                failure = when (exception.failure) {
                    BizInfoClientException.Failure.NOT_CONFIGURED ->
                        SupportProgramCatalogFacadeException.Failure.NOT_CONFIGURED
                    BizInfoClientException.Failure.UPSTREAM_ERROR ->
                        SupportProgramCatalogFacadeException.Failure.UPSTREAM_ERROR
                    BizInfoClientException.Failure.INVALID_RESPONSE ->
                        SupportProgramCatalogFacadeException.Failure.INVALID_RESPONSE
                    BizInfoClientException.Failure.UNAVAILABLE ->
                        SupportProgramCatalogFacadeException.Failure.UNAVAILABLE
                    BizInfoClientException.Failure.TIMEOUT ->
                        SupportProgramCatalogFacadeException.Failure.TIMEOUT
                },
                message = exception.message,
                cause = exception,
            )
        }
}
