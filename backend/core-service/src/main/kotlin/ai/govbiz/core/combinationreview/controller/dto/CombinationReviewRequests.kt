package ai.govbiz.core.combinationreview.controller.dto

import ai.govbiz.core.combinationreview.domain.CombinationReviewDraft
import ai.govbiz.core.combinationreview.domain.CombinationReviewInput
import ai.govbiz.core.combinationreview.domain.ParticipationAnswer
import ai.govbiz.core.combinationreview.domain.ProgramExecutionStatus
import ai.govbiz.core.combinationreview.domain.ProgramParticipation
import ai.govbiz.core.combinationreview.domain.ReviewProgramIdentity
import ai.govbiz.core.combinationreview.domain.SelectedReviewProgram
import ai.govbiz.core.combinationreview.controller.exception.InvalidCombinationReviewInputException
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Size

data class CreateCombinationReviewRequest(
    val title: String,
    @field:Valid @field:Size(min = 2, max = 2)
    val programs: List<SelectedReviewProgramRequest?>,
) {
    fun toDraft(): CombinationReviewDraft = toDraft(title, programs)
}

data class ReplaceCombinationReviewInputRequest(
    @field:Min(1) @field:Max(Long.MAX_VALUE - 1)
    val expectedRevision: Long,
    val title: String,
    @field:Valid @field:Size(min = 2, max = 2)
    val programs: List<SelectedReviewProgramRequest?>,
) {
    fun toDraft(): CombinationReviewDraft = toDraft(title, programs)
}

data class SelectedReviewProgramRequest(
    val sourceCode: String,
    val sourceProgramId: String,
    val subProgramId: String? = null,
    val participation: ProgramParticipationRequest = ProgramParticipationRequest(),
)

/** 문자열을 명시적으로 enum으로 변환하여 숫자 ordinal을 참여 사실로 받아들이지 않는다. */
data class ProgramParticipationRequest(
    val applicationSubmitted: String = "UNKNOWN",
    val selected: String = "UNKNOWN",
    val commitmentSubmitted: String = "UNKNOWN",
    val agreementSigned: String = "UNKNOWN",
    val executionStatus: String = "UNKNOWN",
    val fundingReceived: String = "UNKNOWN",
) {
    fun toDomain(): ProgramParticipation = ProgramParticipation(
        applicationSubmitted = ParticipationAnswer.valueOf(applicationSubmitted),
        selected = ParticipationAnswer.valueOf(selected),
        commitmentSubmitted = ParticipationAnswer.valueOf(commitmentSubmitted),
        agreementSigned = ParticipationAnswer.valueOf(agreementSigned),
        executionStatus = ProgramExecutionStatus.valueOf(executionStatus),
        fundingReceived = ParticipationAnswer.valueOf(fundingReceived),
    )
}

/** 요청 변환의 검증 실패만 400으로 바꾼다. 저장 자료 손상이나 DB 장애를 입력 오류로 숨기지 않는다. */
private fun toDraft(title: String, programs: List<SelectedReviewProgramRequest?>): CombinationReviewDraft =
    try {
        CombinationReviewDraft(
            title,
            CombinationReviewInput(programs.map { nullableProgram ->
                val program = requireNotNull(nullableProgram)
                SelectedReviewProgram(
                    ReviewProgramIdentity(program.sourceCode, program.sourceProgramId, program.subProgramId),
                    program.participation.toDomain(),
                )
            }),
        )
    } catch (_: IllegalArgumentException) {
        throw InvalidCombinationReviewInputException()
    }
