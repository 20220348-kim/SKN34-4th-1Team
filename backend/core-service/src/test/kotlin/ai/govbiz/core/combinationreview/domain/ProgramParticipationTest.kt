package ai.govbiz.core.combinationreview.domain

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ProgramParticipationTest {
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
