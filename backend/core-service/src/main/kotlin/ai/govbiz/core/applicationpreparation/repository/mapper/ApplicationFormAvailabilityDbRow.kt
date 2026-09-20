package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime

data class ApplicationFormAvailabilityDbRow(
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var lastCompletedReasonCode: String? = null,
    var lastCompletedStatus: String? = null,
    var durationMs: Long? = null,
    var timeoutStage: String? = null,
    var status: String = "PENDING",
    var reasonCode: String = "NEW_PROGRAM",
    var catalogFingerprint: String = "",
    var sourceFingerprint: String? = null,
    var parserVersion: String? = null,
    var extractionModel: String? = null,
    var extractionPromptVersion: String? = null,
    var activeFormVersionId: String? = null,
    var verifiedAt: LocalDateTime? = null,
    var nextRetryAt: LocalDateTime? = null,
    var attemptCount: Int = 0,
    var generation: Long = 1,
    var leaseToken: String? = null,
    var leaseUntil: LocalDateTime? = null,
    var aiStarted: Boolean = false,
    var importSha256: String? = null,
)
