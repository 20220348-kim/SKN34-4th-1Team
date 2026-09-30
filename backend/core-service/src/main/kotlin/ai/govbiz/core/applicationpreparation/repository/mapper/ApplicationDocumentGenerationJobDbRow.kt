package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime

data class ApplicationDocumentGenerationJobDbRow(
    var id: Long = 0,
    var ownerAccountId: Long = 0,
    var preparationId: Long = 0,
    var requestKey: String = "",
    var expectedRevision: Long = 0,
    var status: String = "QUEUED",
    var stage: String? = null,
    var resultJson: String? = null,
    var failureCode: String? = null,
    var failureMessage: String? = null,
    var failureDetailJson: String? = null,
    var createdAt: LocalDateTime? = null,
    var finishedAt: LocalDateTime? = null,
)
