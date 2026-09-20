package ai.govbiz.core.combinationreview.domain

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class CombinationReviewInputTest {
    private val a = ReviewProgramIdentity("BIZINFO", "A")
    private val b = ReviewProgramIdentity("BIZINFO", "B")
    private val c = ReviewProgramIdentity("BIZINFO", "C")

    @Test
    fun twoProgramsProduceOnePairAndPreserveDisplayOrder() {
        val input = input(b, a)
        assertEquals(listOf(ReviewProgramPair(a, b)), input.programPairs())
        assertEquals(listOf(b, a), input.programs.map { it.identity })
    }

    @Test
    fun rejectsAnyCountOtherThanTwo() {
        listOf(emptyList(), listOf(a), listOf(a, b, c), listOf(a, b, c, ReviewProgramIdentity("BIZINFO", "D")))
            .forEach { ids -> assertThrows(IllegalArgumentException::class.java) { input(*ids.toTypedArray()) } }
    }

    @Test
    fun restoresAThreeProgramSnapshotCreatedBeforeTheTwoProgramPolicy() {
        val restored = CombinationReviewInput.restore(listOf(a, b, c).map(::SelectedReviewProgram))
        assertEquals(3, restored.programs.size)
        assertEquals(3, restored.programPairs().size)
    }

    @Test
    fun rejectsTheSameBusinessEvenWhenItsParticipationAnswersDiffer() {
        assertThrows(IllegalArgumentException::class.java) {
            CombinationReviewInput(
                listOf(
                    SelectedReviewProgram(a),
                    SelectedReviewProgram(a.copy(), ProgramParticipation(selected = ParticipationAnswer.YES)),
                ),
            )
        }
    }

    @Test
    fun theSameOriginalIdFromDifferentProvidersIsNotADuplicate() {
        val otherProvider = ReviewProgramIdentity("KSTARTUP", "A")
        assertEquals(listOf(ReviewProgramPair(a, otherProvider)), input(a, otherProvider).programPairs())
    }

    @Test
    fun twoSubProgramsInOneNoticeRemainSeparateBusinesses() {
        val general = a.copy(subProgramId = "general")
        val deepTech = a.copy(subProgramId = "deep-tech")
        assertEquals(listOf(ReviewProgramPair(deepTech, general)), input(general, deepTech).programPairs())
    }

    @Test
    fun delimitersInsideIdsCannotCollapseDistinctBusinesses() {
        val first = ReviewProgramIdentity("BIZINFO", "A:B", "C")
        val second = ReviewProgramIdentity("BIZINFO", "A", "B:C")
        assertNotEquals(first, second)
        assertEquals(listOf(ReviewProgramPair(second, first)), input(first, second).programPairs())
    }

    @Test
    fun laterMutationOfTheCallerListCannotChangeTheInputSnapshot() {
        val callerList = mutableListOf(SelectedReviewProgram(a), SelectedReviewProgram(b))
        val input = CombinationReviewInput(callerList)
        callerList.clear()
        assertEquals(listOf(a, b), input.programs.map { it.identity })
        assertThrows(UnsupportedOperationException::class.java) {
            (input.programs as MutableList<SelectedReviewProgram>).clear()
        }
        assertEquals(listOf(ReviewProgramPair(a, b)), input.programPairs())
    }

    @Test
    fun rejectsSelfPairsAndReversedPairs() {
        assertThrows(IllegalArgumentException::class.java) { ReviewProgramPair(a, a) }
        assertThrows(IllegalArgumentException::class.java) { ReviewProgramPair(b, a) }
    }

    private fun input(vararg identities: ReviewProgramIdentity): CombinationReviewInput =
        CombinationReviewInput(identities.map { SelectedReviewProgram(it) })
}
