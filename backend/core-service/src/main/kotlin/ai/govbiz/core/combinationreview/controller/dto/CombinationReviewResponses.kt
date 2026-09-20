package ai.govbiz.core.combinationreview.controller.dto

import ai.govbiz.core.combinationreview.domain.CombinationReviewSummary
import ai.govbiz.core.combinationreview.domain.SelectedReviewProgram
import ai.govbiz.core.combinationreview.domain.StoredCombinationReview
import ai.govbiz.core.combinationreview.service.dto.CombinationReviewPageResult
import java.time.OffsetDateTime
import java.time.ZoneId

data class CombinationReviewResponse(
    val id: Long,
    val title: String,
    val inputRevision: Long,
    val programs: List<SelectedReviewProgramResponse>,
    val createdAt: OffsetDateTime,
    val updatedAt: OffsetDateTime,
) {
    companion object {
        fun from(review: StoredCombinationReview) = CombinationReviewResponse(
            review.id, review.draft.title, review.inputRevision,
            review.draft.input.programs.map(SelectedReviewProgramResponse::from),
            review.createdAt.atZone(SEOUL).toOffsetDateTime(),
            review.updatedAt.atZone(SEOUL).toOffsetDateTime(),
        )
    }
}

data class SelectedReviewProgramResponse(
    val sourceCode: String,
    val sourceProgramId: String,
    val subProgramId: String?,
    val participation: ProgramParticipationResponse,
) {
    companion object {
        fun from(program: SelectedReviewProgram) = SelectedReviewProgramResponse(
            program.identity.sourceCode, program.identity.sourceProgramId, program.identity.subProgramId,
            program.participation.let {
                ProgramParticipationResponse(
                    it.applicationSubmitted.name, it.selected.name, it.commitmentSubmitted.name,
                    it.agreementSigned.name, it.executionStatus.name, it.fundingReceived.name,
                )
            },
        )
    }
}

data class ProgramParticipationResponse(
    val applicationSubmitted: String,
    val selected: String,
    val commitmentSubmitted: String,
    val agreementSigned: String,
    val executionStatus: String,
    val fundingReceived: String,
)

data class CombinationReviewSummaryResponse(
    val id: Long,
    val title: String,
    val inputRevision: Long,
    val createdAt: OffsetDateTime,
    val updatedAt: OffsetDateTime,
) {
    companion object {
        fun from(review: CombinationReviewSummary) = CombinationReviewSummaryResponse(
            review.id, review.title, review.inputRevision,
            review.createdAt.atZone(SEOUL).toOffsetDateTime(),
            review.updatedAt.atZone(SEOUL).toOffsetDateTime(),
        )
    }
}

data class CombinationReviewPageResponse(
    val items: List<CombinationReviewSummaryResponse>,
    val nextBeforeId: Long?,
) {
    companion object {
        fun from(page: CombinationReviewPageResult) = CombinationReviewPageResponse(
            page.items.map(CombinationReviewSummaryResponse::from), page.nextBeforeId,
        )
    }
}

private val SEOUL = ZoneId.of("Asia/Seoul")
