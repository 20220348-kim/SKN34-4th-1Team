package ai.govbiz.core.supportprogram.service.evidence

/** AI 색인·답변 경계에서 특정 공식 원문 구간을 식별하는 내부 값입니다. */
data class SupportProgramEvidenceChunk(
    val id: String,
    val contentHash: String,
    val documentId: String,
    val order: Int,
    val text: String,
)
