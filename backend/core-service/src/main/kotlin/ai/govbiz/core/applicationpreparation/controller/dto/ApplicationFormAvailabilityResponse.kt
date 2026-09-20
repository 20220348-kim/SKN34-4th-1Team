package ai.govbiz.core.applicationpreparation.controller.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormAvailability
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import java.time.LocalDateTime

data class ApplicationFormAvailabilityStateResponse(
    val sourceCode: String, val sourceProgramId: String, val status: String, val reasonCode: String,
    val sourceFingerprint: String?, val parserVersion: String?, val extractionModel: String?,
    val extractionPromptVersion: String?, val activeFormVersionId: String?, val verifiedAt: LocalDateTime?,
    val nextRetryAt: LocalDateTime?, val attemptCount: Int, val durationMs: Long?, val timeoutStage: String?,
)
data class ApplicationFormAvailabilityResponse(val state: ApplicationFormAvailabilityStateResponse, val forms: SupportedApplicationFormsResponse) {
    companion object {
        fun from(state: ApplicationFormAvailability, forms: List<ApplicationFormManifest>) = ApplicationFormAvailabilityResponse(
            ApplicationFormAvailabilityStateResponse(state.sourceCode, state.sourceProgramId, state.status.name, state.reasonCode,
                state.sourceFingerprint, state.parserVersion, state.extractionModel, state.extractionPromptVersion, state.activeFormVersionId,
                state.verifiedAt, state.nextRetryAt, state.attemptCount, state.durationMs, state.timeoutStage), SupportedApplicationFormsResponse.from(forms))
    }
}
