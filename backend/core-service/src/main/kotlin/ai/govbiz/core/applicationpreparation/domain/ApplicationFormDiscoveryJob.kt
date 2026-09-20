package ai.govbiz.core.applicationpreparation.domain

import java.time.LocalDateTime

enum class ApplicationFormDiscoveryJobStatus { QUEUED, RUNNING, SUCCEEDED, FAILED, UNKNOWN }

data class ApplicationFormDiscoveryJob(
    val id: Long,
    val ownerAccountId: Long,
    val requestKey: String,
    val sourceCode: String,
    val sourceProgramId: String,
    val programTitle: String,
    val programSourceUrl: String?,
    val status: ApplicationFormDiscoveryJobStatus,
    val result: ApplicationFormDiscoveryResult?,
    val failureCode: String?,
    val createdAt: LocalDateTime,
)
