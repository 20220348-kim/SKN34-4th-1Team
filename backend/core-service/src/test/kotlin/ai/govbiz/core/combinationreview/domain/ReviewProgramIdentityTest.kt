package ai.govbiz.core.combinationreview.domain

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ReviewProgramIdentityTest {
    @Test
    fun rejectsInvalidProviderCodesWithoutSilentlyNormalizingThem() {
        listOf("", "bizinfo", " BIZINFO", "BIZINFO ", "A:B", "A".repeat(65)).forEach { code ->
            assertThrows(IllegalArgumentException::class.java) { ReviewProgramIdentity(code, "notice") }
        }
    }

    @Test
    fun rejectsBlankUntrimmedOrControlCharacterIds() {
        listOf("", " ", " 공고", "공고 ", "공고\n1", "공고\u200B1", "공고\u00001").forEach { id ->
            assertThrows(IllegalArgumentException::class.java) { ReviewProgramIdentity("BIZINFO", id) }
            assertThrows(IllegalArgumentException::class.java) { ReviewProgramIdentity("BIZINFO", "notice", id) }
        }
    }

    @Test
    fun preservesKoreanAndSpecialCharactersAndDoesNotSplitIdsByDelimiters() {
        val id = ReviewProgramIdentity("BIZINFO", "공고 A:/?&=1", "유형:가/나")
        assertEquals("공고 A:/?&=1", id.sourceProgramId)
        assertEquals("유형:가/나", id.subProgramId)
    }

    @Test
    fun checksTheLengthInUnicodeCodePoints() {
        val boundary = "가".repeat(254) + "\uD83D\uDE80"
        assertEquals(boundary, ReviewProgramIdentity("BIZINFO", boundary, boundary).sourceProgramId)
        assertThrows(IllegalArgumentException::class.java) { ReviewProgramIdentity("BIZINFO", boundary + "가") }
        assertThrows(IllegalArgumentException::class.java) { ReviewProgramIdentity("BIZINFO", "notice", boundary + "가") }
    }

    @Test
    fun absentSubProgramAndASelectedSubProgramAreDifferentIdentities() {
        assertNotEquals(ReviewProgramIdentity("BIZINFO", "notice"), ReviewProgramIdentity("BIZINFO", "notice", "general"))
    }
}
