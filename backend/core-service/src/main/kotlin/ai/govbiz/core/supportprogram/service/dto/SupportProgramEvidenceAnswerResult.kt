package ai.govbiz.core.supportprogram.service.dto

enum class SupportProgramEvidenceAnswerStatus {
    ANSWERED,
    INSUFFICIENT_EVIDENCE,
}

data class SupportProgramEvidenceCitationResult(
    val excerpt: String,
    val sourceUrl: String,
    /** 근거 링크에 보일 원문 이름입니다(예: 기업마당 상세 본문). */
    val sourceLabel: String,
    val chunkOrder: Int,
)

/** 공식 원문 청크만 근거로 만든 특정 공고 질문의 내부 실행 결과입니다. */
data class SupportProgramEvidenceAnswerResult(
    val answer: String,
    val answerStatus: SupportProgramEvidenceAnswerStatus,
    val citations: List<SupportProgramEvidenceCitationResult>,
)
