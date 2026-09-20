package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import org.springframework.stereotype.Service

@Service
class ApplicationFormAnalysisService(
    private val availability: ApplicationFormAvailabilityRepository,
    private val discovery: ApplicationFormDiscoveryService,
    private val ai: AiApplicationPreparationFacade,
    transactionManager: org.springframework.transaction.PlatformTransactionManager,
) {
    private val transactions = org.springframework.transaction.support.TransactionTemplate(transactionManager)
    fun runNext(): Boolean {
        val lease = availability.claim() ?: return false
        var observed = false
        var configuration: ApplicationFormDiscoveryConfiguration? = null
        fun finish(status: ApplicationFormAvailabilityStatus, reason: String, retry: Boolean = false, stage: String? = null) {
            availability.finish(lease, status, reason, retry, timeoutStage=stage, cacheResult=observed, failureConfiguration=configuration)
        }
        try {
            val currentConfiguration = ai.discoveryConfiguration()
            configuration = currentConfiguration
            discovery.analyzeSystem(lease.sourceCode, lease.sourceProgramId, currentConfiguration,
                { metadata -> observed = true; if (!availability.observe(lease, metadata)) throw CompletedAnalysis() },
                { availability.beforeAi(lease) },
                { forms, metadata -> transactions.executeWithoutResult { availability.available(lease, forms, metadata) } })
        } catch (_: CompletedAnalysis) {
            // observe가 완료된 동일 분석을 재사용하고 실행권을 반납했다.
        } catch (error: ApplicationFormDiscoveryException) {
            val reason = error.reason.name
            when (reason) {
                "NO_FORM" -> finish(ApplicationFormAvailabilityStatus.NO_FORM, reason)
                "SOURCE_CHANGED" -> finish(ApplicationFormAvailabilityStatus.STALE, reason)
                "SOURCE_TOO_LARGE" -> finish(ApplicationFormAvailabilityStatus.TOO_LARGE, reason)
                "SOURCE_UNAVAILABLE" -> finish(ApplicationFormAvailabilityStatus.RETRY_WAITING, reason, true,
                    if (generateSequence(error as Throwable?) { it.cause }.any { it is java.net.SocketTimeoutException || it is java.net.http.HttpTimeoutException }) "SOURCE_DOWNLOAD" else null)
                "SOURCE_NOT_FOUND", "SOURCE_UNSUPPORTED", "SOURCE_INVALID" -> finish(ApplicationFormAvailabilityStatus.DOCUMENT_UNAVAILABLE, reason)
                else -> finish(ApplicationFormAvailabilityStatus.REVIEW_REQUIRED, reason)
            }
        } catch (error: ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationFormTimeoutException) {
            finish(ApplicationFormAvailabilityStatus.RETRY_WAITING, "DISCOVERY_TIMEOUT", true, stage=error.stage)
        } catch (error: ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException) {
            finish(ApplicationFormAvailabilityStatus.REVIEW_REQUIRED, error.code)
        } catch (error: AiServiceCallException) {
            val retry = error.failure.name in setOf("UNAVAILABLE", "TIMEOUT")
            finish(if (retry) ApplicationFormAvailabilityStatus.RETRY_WAITING else ApplicationFormAvailabilityStatus.REVIEW_REQUIRED,
                "AI_${error.failure.name}", retry, if (error.failure.name == "TIMEOUT") (if (observed) "AI_UNKNOWN" else "CORE_CONFIGURATION") else null)
        } catch (_: IllegalArgumentException) {
            finish(ApplicationFormAvailabilityStatus.REVIEW_REQUIRED, "DISCOVERY_CONFIGURATION_INVALID")
        } catch (_: SupportProgramNotFoundException) {
            finish(ApplicationFormAvailabilityStatus.DOCUMENT_UNAVAILABLE, "SOURCE_NOT_FOUND")
        }
        // DB 실패나 예상하지 못한 오류는 감추지 않는다. 실행권 만료 후 AI 시작 여부로 복구한다.
        return true
    }
    private class CompletedAnalysis : RuntimeException()
}
