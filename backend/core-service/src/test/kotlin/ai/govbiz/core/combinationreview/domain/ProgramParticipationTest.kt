package ai.govbiz.core.combinationreview.domain

import ai.govbiz.core.combinationreview.domain.ParticipationAnswer.NO
import ai.govbiz.core.combinationreview.domain.ParticipationAnswer.YES
import ai.govbiz.core.combinationreview.domain.ProgramExecutionStatus.COMPLETED
import ai.govbiz.core.combinationreview.domain.ProgramExecutionStatus.IN_PROGRESS
import ai.govbiz.core.combinationreview.domain.ProgramExecutionStatus.NOT_STARTED
import ai.govbiz.core.combinationreview.domain.ProgramExecutionStatus.STOPPED
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ProgramParticipationTest {
    /**
     * shared `currentStatusToParticipation(status, unknownParticipation())`가 저장하는 사실과
     * `participationToCurrentStatus`의 10값을 계약 표의 4값으로 묶은 결과다(CombinationReviewParticipation.test.ts·currentStatus.test.ts와 같은 사례).
     */
    @Test
    fun everyStatusSavedByTheSharedPickerMapsToTheContractStatus() {
        val cases = listOf(
            // BEFORE_APPLICATION
            ProgramParticipation(applicationSubmitted = NO) to ReviewProgramStatus.NOT_APPLIED,
            // APPLICATION
            ProgramParticipation(applicationSubmitted = YES) to ReviewProgramStatus.APPLIED,
            // NOT_SELECTED
            ProgramParticipation(applicationSubmitted = YES, selected = NO) to ReviewProgramStatus.APPLIED,
            // SELECTED
            ProgramParticipation(selected = YES, commitmentSubmitted = NO) to ReviewProgramStatus.ACTIVE,
            // COMMITMENT
            ProgramParticipation(commitmentSubmitted = YES) to ReviewProgramStatus.ACTIVE,
            // AGREEMENT
            ProgramParticipation(agreementSigned = YES, executionStatus = NOT_STARTED) to ReviewProgramStatus.ACTIVE,
            // IN_PROGRESS
            ProgramParticipation(executionStatus = IN_PROGRESS) to ReviewProgramStatus.ACTIVE,
            // COMPLETED
            ProgramParticipation(executionStatus = COMPLETED) to ReviewProgramStatus.FINISHED,
            // STOPPED
            ProgramParticipation(executionStatus = STOPPED) to ReviewProgramStatus.FINISHED,
            // UNKNOWN
            ProgramParticipation() to ReviewProgramStatus.UNKNOWN,
        )
        for ((facts, expected) in cases) assertEquals(expected, facts.reviewStatus(), facts.toString())
    }

    /**
     * shared `reviewStatusToParticipation(status, previous)`가 세부·상충 사실 위에 4값을 골라 저장한 사실이다.
     * shared 테스트(round-trips every chosen status)처럼 Core도 고른 값 그대로 읽어야 한다. 교부 YES는 그대로 남는다.
     */
    @Test
    fun statusesChosenOverDetailedOrContradictorySavedFactsReadBackAsChosen() {
        val cases = listOf(
            // 미선정(NOT_SELECTED)에서 ACTIVE → IN_PROGRESS 대표 사실, 선정 NO는 모름으로
            ProgramParticipation(applicationSubmitted = YES, executionStatus = IN_PROGRESS, fundingReceived = YES) to ReviewProgramStatus.ACTIVE,
            // 상충(협약 YES·수행 모름)에서 FINISHED → COMPLETED 대표 사실
            ProgramParticipation(agreementSigned = YES, executionStatus = COMPLETED, fundingReceived = YES) to ReviewProgramStatus.FINISHED,
            // 상충에서 APPLIED → APPLICATION 대표 사실, 이후 단계는 모름으로
            ProgramParticipation(applicationSubmitted = YES, fundingReceived = YES) to ReviewProgramStatus.APPLIED,
            // 수행 중에서 NOT_APPLIED → BEFORE_APPLICATION 대표 사실
            ProgramParticipation(applicationSubmitted = NO, fundingReceived = YES) to ReviewProgramStatus.NOT_APPLIED,
            // 수행 완료에서 UNKNOWN → 진행 사실만 모름으로
            ProgramParticipation(fundingReceived = YES) to ReviewProgramStatus.UNKNOWN,
            // 확약(COMMITMENT)에서 FINISHED → 신청 NO 등은 모름, 확약 YES는 남음
            ProgramParticipation(commitmentSubmitted = YES, executionStatus = COMPLETED, fundingReceived = YES) to ReviewProgramStatus.FINISHED,
        )
        for ((facts, expected) in cases) assertEquals(expected, facts.reviewStatus(), facts.toString())
    }

    @Test
    fun laterStepsWinWhenEarlierFactsAreAlsoKnownAndFundingIsIgnored() {
        val completedWithHistory = ProgramParticipation(YES, YES, YES, YES, COMPLETED, YES)
        assertEquals(ReviewProgramStatus.FINISHED, completedWithHistory.reviewStatus())
        assertEquals(ReviewProgramStatus.ACTIVE, ProgramParticipation(YES, YES, YES, YES, IN_PROGRESS, NO).reviewStatus())
        assertEquals(ReviewProgramStatus.ACTIVE, ProgramParticipation(applicationSubmitted = YES, selected = YES, commitmentSubmitted = YES).reviewStatus())
        assertEquals(ReviewProgramStatus.UNKNOWN, ProgramParticipation(fundingReceived = YES).reviewStatus())
        // 상충 사실이 없을 때 신청 NO만 남으면 신청 전이다. 교부 사실은 결과를 바꾸지 않는다.
        assertEquals(ReviewProgramStatus.NOT_APPLIED, ProgramParticipation(applicationSubmitted = NO, fundingReceived = YES).reviewStatus())
    }

    @Test
    fun contradictoryOrUnorderableFactsBecomeUnknownRatherThanAGuessedStatus() {
        val unknown = listOf(
            // 협약은 했지만 수행 사실이 없다(shared: agreement without an execution fact).
            ProgramParticipation(agreementSigned = YES, fundingReceived = NO),
            // 선정만 알고 확약 여부를 모른다(shared: selected YES only).
            ProgramParticipation(selected = YES, fundingReceived = NO),
            // 선정·확약·협약 YES인데 수행 사실이 없다.
            ProgramParticipation(selected = YES, commitmentSubmitted = YES, agreementSigned = YES, fundingReceived = NO),
            // 미선정인데 이후 단계 사실이 있다.
            ProgramParticipation(selected = NO, commitmentSubmitted = YES),
            ProgramParticipation(selected = NO, agreementSigned = YES, executionStatus = IN_PROGRESS),
            ProgramParticipation(applicationSubmitted = YES, selected = NO, executionStatus = NOT_STARTED),
            // 협약 NO인데 수행 사실이 있다.
            ProgramParticipation(agreementSigned = NO, executionStatus = COMPLETED),
            // 신청 NO인데 이후 단계 사실이 있다.
            ProgramParticipation(applicationSubmitted = NO, selected = YES),
            ProgramParticipation(applicationSubmitted = NO, commitmentSubmitted = YES),
            ProgramParticipation(applicationSubmitted = NO, executionStatus = STOPPED),
            // 순서를 정할 수 없는 사실만 있다.
            ProgramParticipation(applicationSubmitted = YES, selected = YES),
            ProgramParticipation(selected = NO),
            ProgramParticipation(agreementSigned = NO),
            ProgramParticipation(executionStatus = NOT_STARTED),
        )
        for (facts in unknown) assertEquals(ReviewProgramStatus.UNKNOWN, facts.reviewStatus(), facts.toString())
    }

    @Test
    fun missingFactsRemainUnknownRatherThanNo() {
        val facts = ProgramParticipation()
        assertEquals(ParticipationAnswer.UNKNOWN, facts.applicationSubmitted)
        assertEquals(ParticipationAnswer.UNKNOWN, facts.selected)
        assertEquals(ParticipationAnswer.UNKNOWN, facts.commitmentSubmitted)
        assertEquals(ParticipationAnswer.UNKNOWN, facts.agreementSigned)
        assertEquals(ProgramExecutionStatus.UNKNOWN, facts.executionStatus)
        assertEquals(ParticipationAnswer.UNKNOWN, facts.fundingReceived)
    }

    @Test
    fun selectionDoesNotAutomaticallyMeanCommitmentAgreementExecutionOrPayment() {
        val facts = ProgramParticipation(
            selected = ParticipationAnswer.YES,
            commitmentSubmitted = ParticipationAnswer.NO,
            fundingReceived = ParticipationAnswer.NO,
        )
        assertEquals(ParticipationAnswer.UNKNOWN, facts.applicationSubmitted)
        assertEquals(ParticipationAnswer.YES, facts.selected)
        assertEquals(ParticipationAnswer.NO, facts.commitmentSubmitted)
        assertEquals(ParticipationAnswer.UNKNOWN, facts.agreementSigned)
        assertEquals(ProgramExecutionStatus.UNKNOWN, facts.executionStatus)
        assertEquals(ParticipationAnswer.NO, facts.fundingReceived)
    }

    @Test
    fun completionDoesNotEraseFundingHistoryOrMutateThePreviousSnapshot() {
        val before = ProgramParticipation(executionStatus = ProgramExecutionStatus.IN_PROGRESS, fundingReceived = ParticipationAnswer.YES)
        val after = before.copy(executionStatus = ProgramExecutionStatus.COMPLETED)
        assertEquals(ParticipationAnswer.YES, after.fundingReceived)
        assertEquals(ProgramExecutionStatus.IN_PROGRESS, before.executionStatus)
    }
}
