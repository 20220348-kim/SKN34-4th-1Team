package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoSourceDocumentClient
import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoSourceDocumentClientException
import ai.govbiz.core.supportprogram.client.bizinfo.mapper.BizInfoSourceDocumentMapper
import ai.govbiz.core.supportprogram.client.kstartup.KStartupSourceDocumentClient
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupSourceDocumentClientException
import ai.govbiz.core.supportprogram.client.kstartup.mapper.KStartupSourceDocumentMapper
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramSourceDocumentFacadeException
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Component

/** 기업마당·K-Startup 상세 원문을 제공처별로 읽고 검증된 근거 문서로 변환하는 단일 진입점입니다. */
@Component
class SupportProgramSourceDocumentFacade(
    private val bizInfoClient: BizInfoSourceDocumentClient,
    private val kStartupClient: KStartupSourceDocumentClient,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun load(program: SupportProgram): SupportProgramSourceDocument =
        try {
            when (program.sourceCode) {
                BIZINFO_SOURCE_CODE -> BizInfoSourceDocumentMapper.fromHtml(
                    program = program,
                    html = bizInfoClient.fetchHtml(program.sourceUrl, program.id),
                    fetchedAt = LocalDateTime.now(clock),
                )
                KSTARTUP_SOURCE_CODE -> KStartupSourceDocumentMapper.fromHtml(
                    program = program,
                    html = kStartupClient.fetchHtml(program.sourceUrl, program.id),
                    fetchedAt = LocalDateTime.now(clock),
                )
                // 지원 제공처 판단은 Service가 먼저 합니다. 여기까지 오면 호출 순서 오류입니다.
                else -> throw IllegalStateException("Source document is not supported for ${program.sourceCode}")
            }
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
        } catch (exception: KStartupSourceDocumentClientException) {
            throw SupportProgramSourceDocumentFacadeException.fromClient(
                failure = when (exception.failure) {
                    KStartupSourceDocumentClientException.Failure.UPSTREAM_ERROR ->
                        SupportProgramSourceDocumentFacadeException.Failure.UPSTREAM_ERROR
                    KStartupSourceDocumentClientException.Failure.INVALID_RESPONSE ->
                        SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE
                    KStartupSourceDocumentClientException.Failure.UNAVAILABLE ->
                        SupportProgramSourceDocumentFacadeException.Failure.UNAVAILABLE
                    KStartupSourceDocumentClientException.Failure.TIMEOUT ->
                        SupportProgramSourceDocumentFacadeException.Failure.TIMEOUT
                },
                message = exception.message,
                cause = exception,
            )
        } catch (exception: IllegalArgumentException) {
            // Mapper가 상세 영역·공고명·본문 길이 검증에 실패한 경우입니다.
            throw SupportProgramSourceDocumentFacadeException.fromClient(
                failure = SupportProgramSourceDocumentFacadeException.Failure.INVALID_RESPONSE,
                message = exception.message,
                cause = exception,
            )
        }

    private companion object {
        const val BIZINFO_SOURCE_CODE = "BIZINFO"
        const val KSTARTUP_SOURCE_CODE = "KSTARTUP"
    }
}
