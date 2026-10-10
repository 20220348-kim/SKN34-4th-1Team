package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormDiscoveryJobRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException.Reason
import ai.govbiz.core.planusage.domain.PlanUsageJob
import ai.govbiz.core.planusage.service.PlanUsageService
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException
import org.springframework.beans.factory.annotation.Value
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.slf4j.LoggerFactory

@Service
class ApplicationFormDiscoveryJobService(
    private val repository: ApplicationFormDiscoveryJobRepository,
    private val discovery: ApplicationFormDiscoveryService,
    private val admission: SupportProgramRequestAdmissionService,
    private val planUsage: PlanUsageService,
    transactionManager: PlatformTransactionManager,
    @param:Value("\${app.application-form-discovery.queue.enabled:false}") private val enabled: Boolean,
) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val transactions = TransactionTemplate(transactionManager)

    /** 사용자가 고른 공고의 양식 분석을 접수한다. 신청 문서 월 한도는 공고 하나를 한 건으로 같은 transaction에서 확인한다. */
    fun submit(account: Account, requestKey: String, sourceCode: String, programId: String) = run {
        if (!enabled) throw ApplicationFormDiscoveryException(Reason.QUEUE_UNAVAILABLE)
        discovery.validateIdentity(sourceCode, programId)
        try {
            admission.execute("application-form-discovery-account:${account.id}") {
                requireNotNull(transactions.execute { _ ->
                    repository.reserve(account.id, requestKey.lowercase(), sourceCode, programId).also { job ->
                        planUsage.requireMonthlyCapacity(account.id, PlanUsageJob.FormDiscovery(job.id))
                    }
                })
            }
        } catch (error: DuplicateKeyException) {
            throw ApplicationFormDiscoveryException(Reason.JOB_CONFLICT, error)
        }
    }

    fun get(account: Account, id: Long) = repository.findOwned(account.id, id)
        ?: throw ApplicationFormDiscoveryException(Reason.JOB_NOT_FOUND)
    fun list(account: Account) = repository.listOwned(account.id)

    /** 그 공고에서 끝난 분석 결과를 확인한 것으로 표시한다. 사용자가 결과 화면을 열었을 때 부른다. */
    fun markSeen(account: Account, sourceCode: String, programId: String) {
        discovery.validateIdentity(sourceCode, programId)
        repository.markSeen(account.id, sourceCode, programId)
    }

    fun executeQueued(id: Long) {
        try {
            admission.executeBackground {
                val job = repository.claim(id) ?: return@executeBackground
                var aiStarted = false
                val result = try {
                    discovery.discoverQueued(job.sourceCode, job.sourceProgramId) {
                        check(repository.beginAi(id)) { "Discovery execution is no longer active" }
                        aiStarted = true
                    }
                } catch (error: Exception) {
                    val root = generateSequence(error as Throwable) { it.cause }.last()
                    logger.error("application_form_discovery_failed sourceCode={} sourceProgramId={} jobId={} aiStarted={} rootException={} rootMessage={}",
                        job.sourceCode, job.sourceProgramId, id, aiStarted, root.javaClass.name, root.message?.take(500), error)
                    val documentError = error as? ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
                    val code = documentError?.code ?: if (error is ApplicationFormDiscoveryException) "APPLICATION_FORM_${error.reason.name}"
                        else if (error is AiServiceCallException && error.failure == AiServiceFailure.INVALID_RESPONSE) "APPLICATION_FORM_AI_INVALID_RESPONSE"
                        else if (aiStarted) "RUN_OUTCOME_UNKNOWN" else "DISCOVERY_FAILED"
                    // A definite mapping failure must not become a missing business fact or an unknown model outcome.
                    val unknown = if (documentError != null) documentError.code == "APPLICATION_DOCUMENT_OUTCOME_UNKNOWN"
                        else aiStarted && error !is ApplicationFormDiscoveryException &&
                            !(error is AiServiceCallException && error.failure == AiServiceFailure.INVALID_RESPONSE)
                    repository.fail(id, code, unknown = unknown)
                    return@executeBackground
                }
                // 완료 저장 실패는 Consumer가 DLQ로 격리한다. RUNNING 재전달은 AI를 다시 호출하지 않는다.
                repository.succeed(id, result)
            }
        } catch (error: SupportProgramRequestRejectedException) {
            if (error.reason != SupportProgramRequestRejectedException.Reason.BUSY) throw error
            // 실행권 획득 전 슬롯 부족: QUEUED를 유지한다. Outbox가 나중에 다시 전달한다.
        }
    }
}
