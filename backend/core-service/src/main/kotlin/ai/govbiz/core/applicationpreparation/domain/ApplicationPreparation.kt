package ai.govbiz.core.applicationpreparation.domain

import java.time.LocalDateTime

enum class ApplicationProgressStage {
    PREPARING,
    APPLIED,
    DOCUMENT_REVIEW,
    PRESENTATION_REVIEW,
    SELECTED,
    REJECTED,
}

data class NewApplicationPreparation(
    val sourceCode: String,
    val sourceProgramId: String,
    val formVersionId: String,
    val serviceField: ApplicationServiceField,
) {
    init {
        require(Regex("[A-Z][A-Z0-9_]{0,63}").matches(sourceCode)) { "invalid sourceCode" }
        require(
            sourceProgramId == sourceProgramId.trim() && sourceProgramId.isNotBlank() &&
                sourceProgramId.codePointCount(0, sourceProgramId.length) <= 255 &&
                !Regex("\\p{C}").containsMatchIn(sourceProgramId),
        ) { "invalid sourceProgramId" }
        require(Regex("[a-z0-9][a-z0-9-]{0,159}").matches(formVersionId)) { "invalid formVersionId" }
    }
}

data class StoredApplicationPreparation(
    val id: Long,
    val ownerAccountId: Long,
    val inputRevision: Long,
    val progressStage: ApplicationProgressStage,
    val progressRevision: Long,
    val progressStageUpdatedAt: LocalDateTime,
    val draft: NewApplicationPreparation,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime,
) {
    init {
        require(id > 0 && ownerAccountId > 0 && inputRevision > 0 && progressRevision > 0) {
            "stored application preparation identifiers and revision must be positive"
        }
    }
}

data class ApplicationPreparationSummary(
    val id: Long,
    val inputRevision: Long,
    val progressStage: ApplicationProgressStage,
    val progressRevision: Long,
    val progressStageUpdatedAt: LocalDateTime,
    val sourceCode: String,
    val sourceProgramId: String,
    val formVersionId: String,
    val serviceField: ApplicationServiceField,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime,
    /** 현재 입력 버전으로 생성된 문서 파일이 있으면 완료로 본다. */
    val hasCurrentDocument: Boolean = false,
)

/** 목록 필터: 완료 = 현재 입력 버전의 문서가 있음. */
enum class ApplicationPreparationListStatus { IN_PROGRESS, DONE }

sealed interface ApplicationProgressUpdateResult {
    data object NotFound : ApplicationProgressUpdateResult
    data object RevisionConflict : ApplicationProgressUpdateResult
    data class Updated(val preparation: StoredApplicationPreparation) : ApplicationProgressUpdateResult
}
