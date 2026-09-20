package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime

data class ApplicationFormDiscoveryJobDbRow(
    var id: Long = 0,
    var ownerAccountId: Long = 0,
    var requestKey: String = "",
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var programTitle: String = "",
    var programSourceUrl: String? = null,
    var status: String = "QUEUED",
    var resultJson: String? = null,
    var failureCode: String? = null,
    var createdAt: LocalDateTime? = null,
)
