package ai.govbiz.core.combinationreview.domain

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class CombinationReviewDraftTest {
    private val input = CombinationReviewInput(
        listOf("a", "b").map { SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", it)) },
    )

    @Test
    fun rejectsBlankUntrimmedOrControlCharacterTitles() {
        listOf("", " ", " 제목", "제목 ", "제목\n추가", "제목\u200B").forEach { title ->
            assertThrows(IllegalArgumentException::class.java) { CombinationReviewDraft(title, input) }
        }
    }

    @Test
    fun preservesSpecialCharactersAndUsesCodePointsForTheTitleLimit() {
        val title = "가".repeat(199) + "🚀"
        assertEquals(title, CombinationReviewDraft(title, input).title)
        assertEquals("일반형 & '딥테크'", CombinationReviewDraft("일반형 & '딥테크'", input).title)
        assertThrows(IllegalArgumentException::class.java) { CombinationReviewDraft(title + "가", input) }
    }
}
