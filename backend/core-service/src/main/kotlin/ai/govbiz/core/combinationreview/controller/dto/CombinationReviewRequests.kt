package ai.govbiz.core.combinationreview.controller.dto

import ai.govbiz.core.combinationreview.domain.CombinationReviewDraft
import ai.govbiz.core.combinationreview.domain.CombinationReviewInput
import ai.govbiz.core.combinationreview.domain.ParticipationAnswer
import ai.govbiz.core.combinationreview.domain.ProgramExecutionStatus
import ai.govbiz.core.combinationreview.domain.ProgramParticipation
import ai.govbiz.core.combinationreview.domain.ReviewProgramIdentity
import ai.govbiz.core.combinationreview.domain.ReviewRelation
import ai.govbiz.core.combinationreview.domain.SelectedReviewProgram
import ai.govbiz.core.combinationreview.controller.exception.InvalidCombinationReviewInputException
import com.fasterxml.jackson.annotation.JsonSetter
import com.fasterxml.jackson.annotation.Nulls
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Size

data class CreateCombinationReviewRequest(
    val title: String,
    @field:Valid @field:Size(min = 2, max = 2)
    val programs: List<SelectedReviewProgramRequest?>,
    val relation: ReviewRelationRequest = ReviewRelationRequest(),
) {
    fun toDraft(): CombinationReviewDraft = toDraft(title, programs, relation)
}

data class ReplaceCombinationReviewInputRequest(
    @field:Min(1) @field:Max(Long.MAX_VALUE - 1)
    val expectedRevision: Long,
    val title: String,
    @field:Valid @field:Size(min = 2, max = 2)
    val programs: List<SelectedReviewProgramRequest?>,
    /** 생략하면 저장된 관계를 유지한다. 관계를 보내지 않는 이전 화면의 저장이 다른 화면의 선택을 지우지 않게 한다. 명시적 null은 400이다. */
    @field:JsonSetter(nulls = Nulls.FAIL)
    val relation: ReviewRelationRequest? = null,
) {
    /** 관계를 생략한 요청의 초안 관계는 저장하지 않으며, Repository가 저장된 값을 유지한다. */
    fun toDraft(): CombinationReviewDraft = toDraft(title, programs, relation ?: ReviewRelationRequest())

    fun keepsStoredRelation(): Boolean = relation == null
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

/** 검토 단위 사업쌍 관계. 생성에서 생략하면 UNKNOWN이고, 보낸 객체 안에서 생략한 칸도 UNKNOWN이다. */
data class ReviewRelationRequest(
    val sameProject: String = "UNKNOWN",
    val sameCost: String = "UNKNOWN",
) {
    fun toDomain(): ReviewRelation = ReviewRelation(ParticipationAnswer.valueOf(sameProject), ParticipationAnswer.valueOf(sameCost))
}

/** 요청 변환의 검증 실패만 400으로 바꾼다. 저장 자료 손상이나 DB 장애를 입력 오류로 숨기지 않는다. */
private fun toDraft(title: String, programs: List<SelectedReviewProgramRequest?>, relation: ReviewRelationRequest): CombinationReviewDraft =
    try {
        CombinationReviewDraft(
            title,
            CombinationReviewInput(programs.map { nullableProgram ->
                val program = requireNotNull(nullableProgram)
                SelectedReviewProgram(
                    ReviewProgramIdentity(program.sourceCode, program.sourceProgramId, program.subProgramId),
                    program.participation.toDomain(),
                )
            }, relation.toDomain()),
        )
    } catch (_: IllegalArgumentException) {
        throw InvalidCombinationReviewInputException()
    }
