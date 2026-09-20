package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime

data class ApplicationPreparationFactDbRow(
    var id: Long = 0,
    var preparationId: Long = 0,
    var sectionKey: String = "",
    var fieldKey: String = "",
    var factStatus: String = "",
    var valueText: String? = null,
    var sourceText: String = "",
    var inputRevision: Long = 0,
    var createdAt: LocalDateTime? = null,
    var updatedAt: LocalDateTime? = null,
)

data class ApplicationInterpretationRunDbRow(
    var id: Long = 0,
    var preparationId: Long = 0,
    var sectionKey: String = "",
    var inputRevision: Long = 0,
    var requestKey: String = "",
    var requestHash: String = "",
    var runStatus: String = "RUNNING",
    var inputJson: String = "",
    var outputJson: String? = null,
    var failureCode: String? = null,
    var startedAt: LocalDateTime? = null,
    var finishedAt: LocalDateTime? = null,
)
