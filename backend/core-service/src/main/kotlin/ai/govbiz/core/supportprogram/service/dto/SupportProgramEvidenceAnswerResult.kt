package ai.govbiz.core.supportprogram.service.dto

enum class SupportProgramEvidenceAnswerStatus {
    ANSWERED,
    INSUFFICIENT_EVIDENCE,
}

data class SupportProgramEvidenceCitationResult(
    val excerpt: String,
    val sourceUrl: String,
    val chunkOrder: Int,
)

/** 공식 원문 청크만 근거로 만든 특정 공고 질문의 내부 실행 결과입니다. */
data class SupportProgramEvidenceAnswerResult(
    val answer: String,
    val answerStatus: SupportProgramEvidenceAnswerStatus,
    val citations: List<SupportProgramEvidenceCitationResult>,
)
