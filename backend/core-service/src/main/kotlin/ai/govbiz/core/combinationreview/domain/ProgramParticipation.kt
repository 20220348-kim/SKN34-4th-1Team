package ai.govbiz.core.combinationreview.domain

/** 사용자 입력 사실의 현재 값. UNKNOWN은 NO와 다르며 다른 사실에서 자동으로 추론하지 않는다. */
enum class ParticipationAnswer { UNKNOWN, YES, NO }

enum class ProgramExecutionStatus { UNKNOWN, NOT_STARTED, IN_PROGRESS, COMPLETED, STOPPED }

/**
 * 사업별 참여 사실을 독립적으로 보관한다. 선정·확약·교부는 서로 다른 정보다.
 * 상충하는 사용자 진술의 확인, 날짜·출처, 규정 적용 여부는 후속 입력·검토 계약에서 처리한다.
 */
data class ProgramParticipation(
    val applicationSubmitted: ParticipationAnswer = ParticipationAnswer.UNKNOWN,
    val selected: ParticipationAnswer = ParticipationAnswer.UNKNOWN,
    val commitmentSubmitted: ParticipationAnswer = ParticipationAnswer.UNKNOWN,
    val agreementSigned: ParticipationAnswer = ParticipationAnswer.UNKNOWN,
    val executionStatus: ProgramExecutionStatus = ProgramExecutionStatus.UNKNOWN,
    val fundingReceived: ParticipationAnswer = ParticipationAnswer.UNKNOWN,
)
