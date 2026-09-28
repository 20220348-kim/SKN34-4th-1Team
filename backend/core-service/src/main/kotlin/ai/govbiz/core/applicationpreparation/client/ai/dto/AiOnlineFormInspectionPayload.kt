package ai.govbiz.core.applicationpreparation.client.ai.dto

data class AiOnlineFormInspectionPayload(
    val contractVersion: String,
    val parserVersion: String,
    val sourceUrl: String,
    val finalUrl: String,
    val formTitle: String,
    val semanticFingerprint: String,
    val questions: List<AiOnlineFormQuestionPayload>,
)

data class AiOnlineFormQuestionPayload(
    val order: Int,
    val controlId: String,
    val label: String,
    val required: Boolean,
    val kind: String,
    val options: List<String>,
    val supported: Boolean,
    val unsupportedReason: String?,
)
