package ai.govbiz.core.supportprogram.client.ai.dto

data class AiSupportProgramEvidenceChunkRequest(
    val id: String,
    val contentHash: String,
    val documentId: String,
    val order: Int,
    val text: String,
) {
    fun reference(): AiSupportProgramEvidenceChunkReferenceRequest =
        AiSupportProgramEvidenceChunkReferenceRequest(id, contentHash, documentId, order)

    fun answerInput(): AiSupportProgramEvidenceAnswerChunkRequest =
        AiSupportProgramEvidenceAnswerChunkRequest(id, documentId, order, text)
}

data class AiSupportProgramEvidenceChunkReferenceRequest(
    val id: String,
    val contentHash: String,
    val documentId: String,
    val order: Int,
)

data class AiSupportProgramEvidenceIndexRequest(
    val chunks: List<AiSupportProgramEvidenceChunkRequest>,
)

data class AiSupportProgramEvidenceSearchRequest(
    val question: String,
    val eligibleChunks: List<AiSupportProgramEvidenceChunkReferenceRequest>,
    val limit: Int,
)

data class AiSupportProgramEvidenceAnswerChunkRequest(
    val id: String,
    val documentId: String,
    val order: Int,
    val text: String,
)

data class AiSupportProgramEvidenceAnswerRequest(
    val question: String,
    val chunks: List<AiSupportProgramEvidenceAnswerChunkRequest>,
)
