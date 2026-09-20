package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerStatus

data class SupportProgramEvidenceCitationResponse(
    val excerpt: String,
    val sourceUrl: String,
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
                            chunkOrder = citation.chunkOrder,
                        )
                    },
                ),
            )
    }
}
