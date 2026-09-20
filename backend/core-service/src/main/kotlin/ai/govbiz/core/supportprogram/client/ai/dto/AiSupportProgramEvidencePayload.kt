package ai.govbiz.core.supportprogram.client.ai.dto

data class AiSupportProgramEvidenceIndexPayload(val indexedCount: Int?)

data class AiSupportProgramEvidenceSearchPayload(
    val question: String?,
    val matches: List<AiSupportProgramEvidenceMatchPayload?>?,
)

data class AiSupportProgramEvidenceMatchPayload(
    val id: String?,
    val contentHash: String?,
    val documentId: String?,
    val order: Int?,
    val score: Double?,
)

data class AiSupportProgramEvidenceAnswerPayload(
    val answer: String?,
    val answerStatus: String?,
    val citationChunkIds: List<String?>?,
)
