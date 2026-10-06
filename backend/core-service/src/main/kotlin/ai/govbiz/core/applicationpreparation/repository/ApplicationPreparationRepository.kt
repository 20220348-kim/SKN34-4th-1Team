package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationPreparationSummary
import ai.govbiz.core.applicationpreparation.domain.ApplicationPreparationListStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationProgressStage
import ai.govbiz.core.applicationpreparation.domain.ApplicationProgressUpdateResult
import ai.govbiz.core.applicationpreparation.domain.ApplicationServiceField
import ai.govbiz.core.applicationpreparation.domain.NewApplicationPreparation
import ai.govbiz.core.applicationpreparation.domain.StoredApplicationPreparation
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationDocumentGenerationJobMapper
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationMapper
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 인증된 계정이 소유한 신청 준비 건의 현재 기본정보를 저장하고 읽습니다. */
@Repository
class ApplicationPreparationRepository(
    private val mapper: ApplicationPreparationMapper,
    private val documentJobs: ApplicationDocumentGenerationJobMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    @Transactional
    fun create(ownerAccountId: Long, draft: NewApplicationPreparation): StoredApplicationPreparation {
        require(ownerAccountId > 0) { "ownerAccountId must be positive" }
        val now = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
        val row = ApplicationPreparationDbRow(
            ownerAccountId = ownerAccountId,
            sourceCode = draft.sourceCode,
            sourceProgramId = draft.sourceProgramId,
            formVersionId = draft.formVersionId,
            serviceField = draft.serviceField.name,
            progressStage = ApplicationProgressStage.PREPARING.name,
            progressRevision = 1,
            progressStageUpdatedAt = now,
            createdAt = now,
            updatedAt = now,
        )
        check(mapper.insertPreparation(row) == 1 && row.id > 0) { "application preparation was not created" }
        return row.toStored()
    }

    fun findOwned(ownerAccountId: Long, preparationId: Long): StoredApplicationPreparation? {
        require(ownerAccountId > 0 && preparationId > 0) { "ownerAccountId and preparationId must be positive" }
        return mapper.findOwned(ownerAccountId, preparationId)?.toStored()
    }

    fun listOwned(ownerAccountId: Long, beforeId: Long?, limit: Int, status: ApplicationPreparationListStatus? = null): List<ApplicationPreparationSummary> {
        require(ownerAccountId > 0 && (beforeId == null || beforeId > 0) && limit in 1..51)
        return mapper.listOwned(ownerAccountId, beforeId, limit, status?.name).map { row ->
            ApplicationPreparationSummary(
                id = row.id,
                inputRevision = row.inputRevision,
                progressStage = ApplicationProgressStage.valueOf(row.progressStage),
                progressRevision = row.progressRevision,
                progressStageUpdatedAt = requireNotNull(row.progressStageUpdatedAt),
                sourceCode = row.sourceCode,
                sourceProgramId = row.sourceProgramId,
                formVersionId = row.formVersionId,
                serviceField = ApplicationServiceField.valueOf(row.serviceField),
                createdAt = requireNotNull(row.createdAt),
                updatedAt = requireNotNull(row.updatedAt),
                hasCurrentDocument = row.hasCurrentDocument,
            )
        }
    }

    @Transactional
    fun deleteOwned(ownerAccountId: Long, preparationId: Long): Boolean {
        require(ownerAccountId > 0 && preparationId > 0) { "ownerAccountId and preparationId must be positive" }
        // 생성 접수와 같은 준비 건을 잠가 확인 이후 새 작업이 들어오는 것을 막는다.
        mapper.findOwnedForUpdate(ownerAccountId, preparationId) ?: return false
        if (documentJobs.findActive(preparationId) != null) throw ApplicationPreparationRunConflictException()
        return mapper.deleteOwned(ownerAccountId, preparationId) == 1
    }

    @Transactional
    fun updateProgressOwned(
        ownerAccountId: Long,
        preparationId: Long,
        expectedProgressRevision: Long,
        progressStage: ApplicationProgressStage,
    ): ApplicationProgressUpdateResult {
        require(ownerAccountId > 0 && preparationId > 0 && expectedProgressRevision in 1 until Long.MAX_VALUE)
        val now = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
        if (mapper.updateProgressOwned(ownerAccountId, preparationId, expectedProgressRevision, progressStage.name, now) == 1) {
            return ApplicationProgressUpdateResult.Updated(requireNotNull(mapper.findOwned(ownerAccountId, preparationId)).toStored())
        }
        return if (mapper.findOwned(ownerAccountId, preparationId) === null) {
            ApplicationProgressUpdateResult.NotFound
        } else {
            ApplicationProgressUpdateResult.RevisionConflict
        }
    }

    private fun ApplicationPreparationDbRow.toStored(): StoredApplicationPreparation = StoredApplicationPreparation(
        id = id,
        ownerAccountId = ownerAccountId,
        inputRevision = inputRevision,
        progressStage = ApplicationProgressStage.valueOf(progressStage),
        progressRevision = progressRevision,
        progressStageUpdatedAt = requireNotNull(progressStageUpdatedAt),
        draft = NewApplicationPreparation(
            sourceCode = sourceCode,
            sourceProgramId = sourceProgramId,
            formVersionId = formVersionId,
            serviceField = ApplicationServiceField.valueOf(serviceField),
        ),
        createdAt = requireNotNull(createdAt),
        updatedAt = requireNotNull(updatedAt),
    )
}
