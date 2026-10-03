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
    /** 끝난 결과를 사용자가 확인한 시각. 끝났는데 null이면 아직 확인하지 않은 결과다. */
    val seenAt: LocalDateTime? = null,
)
