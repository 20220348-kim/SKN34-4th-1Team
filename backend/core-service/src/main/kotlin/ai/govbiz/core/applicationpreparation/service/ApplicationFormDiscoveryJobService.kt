package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormDiscoveryJobRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException.Reason
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException
import org.springframework.beans.factory.annotation.Value
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service

@Service
class ApplicationFormDiscoveryJobService(
    private val repository: ApplicationFormDiscoveryJobRepository,
    private val discovery: ApplicationFormDiscoveryService,
    private val admission: SupportProgramRequestAdmissionService,
    @param:Value("\${app.application-form-discovery.queue.enabled:false}") private val enabled: Boolean,
) {
    fun submit(account: Account, requestKey: String, sourceCode: String, programId: String) = run {
        if (!enabled) throw ApplicationFormDiscoveryException(Reason.QUEUE_UNAVAILABLE)
        discovery.validateIdentity(sourceCode, programId)
        try {
            admission.execute("application-form-discovery-account:${account.id}") {
                repository.reserve(account.id, requestKey.lowercase(), sourceCode, programId)
            }
        } catch (error: DuplicateKeyException) {
            throw ApplicationFormDiscoveryException(Reason.JOB_CONFLICT, error)
        }
    }

    fun get(account: Account, id: Long) = repository.findOwned(account.id, id)
        ?: throw ApplicationFormDiscoveryException(Reason.JOB_NOT_FOUND)
    fun list(account: Account) = repository.listOwned(account.id)

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
                    val documentError = error as? ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
                    val code = documentError?.code ?: if (error is ApplicationFormDiscoveryException) "APPLICATION_FORM_${error.reason.name}"
                        else if (aiStarted) "RUN_OUTCOME_UNKNOWN" else "DISCOVERY_FAILED"
                    // A definite mapping failure must not become a missing business fact or an unknown model outcome.
                    val unknown = if (documentError != null) documentError.code == "APPLICATION_DOCUMENT_OUTCOME_UNKNOWN"
                        else aiStarted && error !is ApplicationFormDiscoveryException
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
