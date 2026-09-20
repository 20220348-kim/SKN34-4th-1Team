package ai.govbiz.core.applicationpreparation.domain

import java.time.LocalDateTime

enum class ApplicationFormAvailabilityStatus { PENDING, AVAILABLE, NO_FORM, DOCUMENT_UNAVAILABLE, TOO_LARGE, RETRY_WAITING, STALE, REVIEW_REQUIRED }
data class ApplicationFormAvailability(
    val sourceCode: String, val sourceProgramId: String, val status: ApplicationFormAvailabilityStatus,
    val reasonCode: String, val sourceFingerprint: String?, val parserVersion: String?,
    val extractionModel: String?, val extractionPromptVersion: String?, val activeFormVersionId: String?,
    val verifiedAt: LocalDateTime?, val nextRetryAt: LocalDateTime?, val attemptCount: Int, val durationMs: Long? = null, val timeoutStage: String? = null,
)
data class ApplicationFormAnalysisLease(val sourceCode: String, val sourceProgramId: String, val generation: Long, val token: String, val attemptCount: Int, val startedNanos: Long = System.nanoTime())
data class ApplicationFormAnalysisMetadata(val sourceFingerprint: String, val configuration: ApplicationFormDiscoveryConfiguration, val parserVersion: String)
