package ai.govbiz.core.combinationreview.domain

/** 사용자 입력 사실의 현재 값. UNKNOWN은 NO와 다르며 다른 사실에서 자동으로 추론하지 않는다. */
enum class ParticipationAnswer { UNKNOWN, YES, NO }

enum class ProgramExecutionStatus { UNKNOWN, NOT_STARTED, IN_PROGRESS, COMPLETED, STOPPED }

/**
 * 세 질문(v3) 분석에 보내는 사업별 진행 상태 4값과 모름.
 * NOT_APPLIED 신청 전, APPLIED 신청함·심사 중·미선정, ACTIVE 선정·확약·협약·수행 중, FINISHED 수행 완료·중단·지원받음.
 */
enum class ReviewProgramStatus { UNKNOWN, NOT_APPLIED, APPLIED, ACTIVE, FINISHED }

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
) {
    /**
     * 웹·모바일이 쓰는 shared `participationToCurrentStatus`와 같은 순서·규칙으로 현재 상태를 고른 뒤 4값으로 묶는다.
     * 서로 어긋나거나 순서를 정할 수 없는 사실 조합은 UNKNOWN이며, 교부 여부는 상태 계산에 쓰지 않는다.
     */
    fun reviewStatus(): ReviewProgramStatus {
        val yes = ParticipationAnswer.YES
        val no = ParticipationAnswer.NO
        val executionKnown = executionStatus != ProgramExecutionStatus.UNKNOWN
        val contradictory =
            (selected == no && (commitmentSubmitted == yes || agreementSigned == yes || executionKnown)) ||
                (agreementSigned == yes && !executionKnown) ||
                (agreementSigned == no && executionKnown) ||
                (applicationSubmitted == no && (selected == yes || commitmentSubmitted == yes || agreementSigned == yes || executionKnown))
        return when {
            contradictory -> ReviewProgramStatus.UNKNOWN
            // STOPPED·COMPLETED
            executionStatus == ProgramExecutionStatus.STOPPED || executionStatus == ProgramExecutionStatus.COMPLETED -> ReviewProgramStatus.FINISHED
            // IN_PROGRESS·AGREEMENT·COMMITMENT·SELECTED
            executionStatus == ProgramExecutionStatus.IN_PROGRESS -> ReviewProgramStatus.ACTIVE
            agreementSigned == yes && executionStatus == ProgramExecutionStatus.NOT_STARTED -> ReviewProgramStatus.ACTIVE
            commitmentSubmitted == yes -> ReviewProgramStatus.ACTIVE
            selected == yes && commitmentSubmitted == no -> ReviewProgramStatus.ACTIVE
            // NOT_SELECTED·APPLICATION
            selected == no && applicationSubmitted == yes -> ReviewProgramStatus.APPLIED
            applicationSubmitted == yes && selected == ParticipationAnswer.UNKNOWN -> ReviewProgramStatus.APPLIED
            // BEFORE_APPLICATION
            applicationSubmitted == no -> ReviewProgramStatus.NOT_APPLIED
            else -> ReviewProgramStatus.UNKNOWN
        }
    }
}
