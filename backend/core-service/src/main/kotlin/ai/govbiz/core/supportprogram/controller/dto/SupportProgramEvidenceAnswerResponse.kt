package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerStatus

data class SupportProgramEvidenceCitationResponse(
    val excerpt: String,
    val sourceUrl: String,
    /** 근거 링크에 보일 원문 이름입니다. 어느 제공처의 상세 본문인지 화면이 직접 정하지 않게 서버가 줍니다. */
    val sourceLabel: String,
    val chunkOrder: Int,
)

data class SupportProgramEvidenceAnswerResponse(
    val answer: String,
    val answerStatus: SupportProgramEvidenceAnswerStatus,
    val citations: List<SupportProgramEvidenceCitationResponse>,
) {
    companion object {
        fun from(result: SupportProgramEvidenceAnswerResult): SupportProgramEvidenceAnswerResponse =
            SupportProgramEvidenceAnswerResponse(
                answer = result.answer,
                answerStatus = result.answerStatus,
                citations = java.util.List.copyOf(
                    result.citations.map { citation ->
                        SupportProgramEvidenceCitationResponse(
                            excerpt = citation.excerpt,
                            sourceUrl = citation.sourceUrl,
                            sourceLabel = citation.sourceLabel,
                            chunkOrder = citation.chunkOrder,
                        )
                    },
                ),
            )
    }
}
