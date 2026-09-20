package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime

/** application_preparation 한 행을 위한 MyBatis 경계 타입입니다. */
data class ApplicationPreparationDbRow(
    var id: Long = 0,
    var ownerAccountId: Long = 0,
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var formVersionId: String = "",
    var serviceField: String = "",
    var progressStage: String = "PREPARING",
    var progressRevision: Long = 1,
    var progressStageUpdatedAt: LocalDateTime? = null,
    var inputRevision: Long = 1,
    var createdAt: LocalDateTime? = null,
    var updatedAt: LocalDateTime? = null,
)
