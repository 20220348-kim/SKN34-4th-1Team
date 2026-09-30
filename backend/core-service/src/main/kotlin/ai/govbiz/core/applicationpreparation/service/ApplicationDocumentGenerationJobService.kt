package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationJob
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentGenerationJobRepository
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentMigrationNoticeResult
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException
import org.slf4j.LoggerFactory
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service

/**
 * 문서 생성을 계정별 작업으로 접수하고 실행한다. 접수는 HTTP 요청에서, 실행은 [ApplicationDocumentGenerationJobWorker]가
 * 같은 프로세스의 실행 슬롯에서 한다. 생성 규칙 자체는 [ApplicationDocumentService.generateNow]가 그대로 맡는다.
 */
@Service
class ApplicationDocumentGenerationJobService(
    private val repository: ApplicationDocumentGenerationJobRepository,
    private val documents: ApplicationDocumentService,
    private val preparations: ApplicationPreparationService,
    private val accounts: AccountRepository,
    private val admission: SupportProgramRequestAdmissionService,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    fun submit(account: Account, preparationId: Long, requestKey: String, expectedRevision: Long): ApplicationDocumentGenerationJob {
        val detail = preparations.findOwned(account, preparationId)
        if (detail.preparation.inputRevision != expectedRevision) throw ApplicationPreparationRevisionConflictException()
        val reservation = try {
            repository.reserve(account.id, requestKey.lowercase(), preparationId, expectedRevision)
        } catch (error: DuplicateKeyException) {
            throw ApplicationPreparationRunConflictException()
        }
        if (reservation.capacityExceeded) throw ApplicationDocumentException("APPLICATION_DOCUMENT_JOB_CAPACITY",
            "진행 중인 문서 생성이 이미 3건입니다. 끝난 뒤 다시 시도해 주세요.")
        return requireNotNull(reservation.job)
    }

    fun get(account: Account, preparationId: Long, id: Long): ApplicationDocumentGenerationJob =
        repository.findOwned(account.id, preparationId, id) ?: throw ApplicationPreparationNotFoundException()

    fun list(account: Account, preparationId: Long): List<ApplicationDocumentGenerationJob> {
        preparations.findOwned(account, preparationId)
        return repository.listOwned(account.id, preparationId)
    }

    /** 실패한 작업의 입력 위치 변경 안내. 소유자만 읽을 수 있고 승인 토큰은 기존 confirm API로 쓴다. */
    fun mappingMigration(account: Account, preparationId: Long, id: Long): ApplicationDocumentMigrationNoticeResult? =
        repository.failureDetail(account.id, preparationId, id, ApplicationDocumentMigrationNoticeResult::class.java)

    /** 작업 하나를 실행한다. 실행 슬롯이 없으면 QUEUED로 두고 다음 주기에 다시 시도한다. */
    fun execute(id: Long): Boolean {
        return try {
            admission.executeBackground {
                val job = repository.claim(id) ?: return@executeBackground true
                val owner = accounts.findById(job.ownerAccountId)
                if (owner == null) {
                    repository.fail(id, "ACCOUNT_INACTIVE", "계정을 확인하지 못해 문서를 생성하지 않았습니다.")
                    return@executeBackground true
                }
                var aiStarted = false
                try {
                    val files = documents.generateNow(owner, job.preparationId, job.expectedRevision,
                        onStage = { stage -> repository.updateStage(id, stage) },
                        onAiStart = { check(repository.beginAi(id)) { "Document generation job is no longer active" }; aiStarted = true })
                    repository.succeed(id, files.map { it.id })
                } catch (error: Exception) {
                    record(job, error, aiStarted)
                }
                true
            }
        } catch (error: SupportProgramRequestRejectedException) {
            if (error.reason != SupportProgramRequestRejectedException.Reason.BUSY) throw error
            false
        }
    }

    private fun record(job: ApplicationDocumentGenerationJob, error: Exception, aiStarted: Boolean) {
        val root = generateSequence(error as Throwable) { it.cause }.last()
        logger.warn("application_document_generation_failed preparationId={} jobId={} aiStarted={} rootException={} rootMessage={}",
            job.preparationId, job.id, aiStarted, root.javaClass.name, root.message?.take(500))
        when (error) {
            is ApplicationDocumentException -> repository.fail(job.id, error.code, error.message ?: "문서를 생성하지 못했습니다.",
                detail = error.mappingMigration, unknown = error.code == "APPLICATION_DOCUMENT_OUTCOME_UNKNOWN")
            is ApplicationPreparationRevisionConflictException -> repository.fail(job.id, "APPLICATION_PREPARATION_REVISION_CONFLICT",
                "답변이 변경되었습니다. 답변 입력으로 돌아가 최신 내용을 확인한 뒤 다시 생성해 주세요.")
            is ApplicationPreparationRunConflictException -> repository.fail(job.id, "APPLICATION_PREPARATION_RUN_CONFLICT",
                "같은 작성본의 문서 생성이 이미 진행 중입니다. 잠시 후 저장된 결과를 확인해 주세요.")
            is ApplicationPreparationNotFoundException -> repository.fail(job.id, "APPLICATION_PREPARATION_NOT_FOUND", "작성본을 찾지 못했습니다.")
            // 유료 호출 뒤의 알 수 없는 실패는 결과 불명으로 두어 사람이 저장된 파일을 확인하게 한다.
            else -> repository.fail(job.id, if (aiStarted) "RUN_OUTCOME_UNKNOWN" else "GENERATION_FAILED",
                if (aiStarted) "문서 생성 결과를 확인하지 못했습니다. 저장된 문서 목록을 확인한 뒤 필요하면 다시 만들어 주세요."
                else "문서를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.", unknown = aiStarted)
        }
    }
}
