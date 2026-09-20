package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime

data class ApplicationPreparationContentDbRow(
    var id: Long = 0,
    var preparationId: Long = 0,
    var sectionKey: String = "",
    var inputRevision: Long = 0,
    var contentKind: String = "AI_DRAFT",
    var contentText: String = "",
    var factsJson: String = "[]",
    var runId: Long? = null,
    var createdAt: LocalDateTime? = null,
    var confirmedAt: LocalDateTime? = null,
)

data class ApplicationPreparationDraftRunDbRow(
    var id: Long = 0,
    var preparationId: Long = 0,
    var sectionKey: String = "",
    var inputRevision: Long = 0,
    var expectedVersionId: Long? = null,
    var requestKey: String = "",
    var runStatus: String = "RUNNING",
    var inputJson: String = "{}",
    var outputJson: String? = null,
    var applied: Boolean = false,
    var startedAt: LocalDateTime? = null,
    var finishedAt: LocalDateTime? = null,
)
