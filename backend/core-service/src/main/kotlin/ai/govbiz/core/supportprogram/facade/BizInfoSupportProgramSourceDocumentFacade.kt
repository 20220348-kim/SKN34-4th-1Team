package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoSourceDocumentClient
import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoSourceDocumentClientException
import ai.govbiz.core.supportprogram.client.bizinfo.mapper.BizInfoSourceDocumentMapper
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramSourceDocumentFacadeException
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Component

/** 기업마당 상세 원문을 읽고 검증된 근거 문서로 변환하는 단일 진입점입니다. */
@Component
class BizInfoSupportProgramSourceDocumentFacade(
    private val client: BizInfoSourceDocumentClient,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun load(program: SupportProgram): SupportProgramSourceDocument =
        try {
            check(program.sourceCode == BIZINFO_SOURCE_CODE) { "BizInfo source document requires BIZINFO" }
            BizInfoSourceDocumentMapper.fromHtml(
                program = program,
                html = client.fetchHtml(program.sourceUrl, program.id),
                fetchedAt = LocalDateTime.now(clock),
            )
        } catch (exception: BizInfoSourceDocumentClientException) {
            throw SupportProgramSourceDocumentFacadeException.fromClient(
                failure = when (exception.failure) {
                    BizInfoSourceDocumentClientException.Failure.UPSTREAM_ERROR ->
                        SupportProgramSourceDocumentFacadeException.Failure.UPSTREAM_ERROR
                    BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE ->
                        SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE
                    BizInfoSourceDocumentClientException.Failure.UNAVAILABLE ->
                        SupportProgramSourceDocumentFacadeException.Failure.UNAVAILABLE
                    BizInfoSourceDocumentClientException.Failure.TIMEOUT ->
                        SupportProgramSourceDocumentFacadeException.Failure.TIMEOUT
                },
                message = exception.message,
                cause = exception,
            )
        } catch (exception: IllegalArgumentException) {
            throw SupportProgramSourceDocumentFacadeException.fromClient(
                failure = SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE,
                message = exception.message,
                cause = exception,
            )
        }

    private companion object {
        const val BIZINFO_SOURCE_CODE = "BIZINFO"
    }
}
