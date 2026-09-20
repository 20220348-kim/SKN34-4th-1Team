package ai.govbiz.core.supportprogram.client.msit.mapper

import ai.govbiz.core.supportprogram.client.msit.dto.MsitProgramPayload
import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

class MsitProgramMapperTest {
    @Test
    fun normalizesTheOfficialTitleButNeverGuessesApplicationDatesEligibilityRegionsOrCategories() {
        val result = MsitProgramMapper.mapValidated(listOf(payload().copy(
            title = "<b>R&amp;D 지원</b><script>unsafe()</script>", organization = "<p>연구개발정책과</p>",
        ))).single()
        assertEquals("3186878", result.program.id)
        assertEquals("MSIT", result.program.sourceCode)
        assertEquals("과학기술정보통신부", result.program.sourceName)
        assertEquals("R&D 지원", result.program.title)
        assertEquals("연구개발정책과", result.program.organization)
        assertEquals("2026-09-09", result.sortTimestamp)
        assertNull(result.program.applicationStartDate)
        assertNull(result.program.applicationEndDate)
        assertEquals("정보 없음", result.program.applicationPeriod)
        assertEquals(SupportProgramStatus.UNKNOWN, result.program.status)
        assertEquals("정보 없음", result.program.targetDescription)
        assertTrue(result.program.categories.isEmpty())
        assertTrue(result.program.regions.isEmpty())
        assertTrue(result.program.summary.contains("모집 여부와 신청 자격은 원문을 확인"))
        assertNull(result.startupDetails)
    }

    @Test
    fun preservesSelectionResultAnnouncementsInsteadOfPretendingEveryItemIsRecruiting() {
        val program = MsitProgramMapper.mapValidated(listOf(payload().copy(title = "사업 선정결과 공고"))).single().program
        assertEquals("사업 선정결과 공고", program.title)
        assertEquals(SupportProgramStatus.UNKNOWN, program.status)
    }

    @Test
    fun missingOrInvalidPublishedDatesHaveNoFabricatedSortDate() {
        for (value in listOf(null, "", "미정", "2026-02-30", "2026-9-9", "20260909")) {
            assertEquals("", MsitProgramMapper.mapValidated(listOf(payload().copy(publishedAt = value))).single().sortTimestamp)
        }
        val program = MsitProgramMapper.mapValidated(listOf(payload().copy(organization = null))).single().program
        assertEquals("과학기술정보통신부", program.organization)
    }

    @Test
    fun rejectsMissingTitlesAndDuplicatesBeforeReturningAnyMappedSnapshot() {
        for (value in listOf(null, "", "  ", "<script>bad</script>")) {
            assertThrows(MsitClientException::class.java) { MsitProgramMapper.mapValidated(listOf(payload().copy(title = value))) }
        }
        assertThrows(MsitClientException::class.java) { MsitProgramMapper.mapValidated(listOf(payload(), payload())) }
    }

    @ParameterizedTest
    @ValueSource(strings = [
        "http://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=1",
        "https://www.msit.go.kr.evil.test/bbs/view.do?bbsSeqNo=100&nttSeqNo=1",
        "https://evil.test@www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=1",
        "https://www.msit.go.kr:444/bbs/view.do?bbsSeqNo=100&nttSeqNo=1",
        "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=1#fragment",
        "https://www.msit.go.kr/other?bbsSeqNo=100&nttSeqNo=1",
        "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=101&nttSeqNo=1",
        "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&bbsSeqNo=100&nttSeqNo=1",
        "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=1&nttSeqNo=1",
        "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=0",
        "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=01",
        "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=",
        "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=%ZZ",
        "", "not a URL",
    ])
    fun rejectsUnsafeOrAmbiguousOfficialLinks(url: String) {
        assertThrows(MsitClientException::class.java) { MsitProgramMapper.mapValidated(listOf(payload().copy(sourceUrl = url))) }
    }

    @Test
    fun acceptsOnlyTheOfficialBoardAndDecodesQueryNamesForIdentityChecks() {
        val url = "https://msit.go.kr:443/bbs/view.do?bbsSeqNo=100&ntt%53eqNo=42"
        val result = MsitProgramMapper.mapValidated(listOf(payload().copy(sourceUrl = url))).single()
        assertEquals("42", result.program.id)
        assertEquals(url, result.program.sourceUrl)
    }

    @Test
    fun validatesDatabaseLimitsBeforeAnyPaidIndexingCanBegin() {
        val oversized = listOf(
            payload().copy(title = "한".repeat(501)), payload().copy(organization = "부".repeat(256)),
            payload().copy(sourceUrl = payload().sourceUrl + "&extra=" + "x".repeat(2048)),
        )
        oversized.forEach {
            assertThrows(MsitClientException::class.java) { MsitProgramMapper.mapValidated(listOf(it)) }
        }
        assertEquals("😀".repeat(500), MsitProgramMapper.mapValidated(listOf(payload().copy(title = "😀".repeat(500)))).single().program.title)
    }

    private fun payload() = MsitProgramPayload(
        title = "사업 공고", organization = "연구개발정책과", publishedAt = "2026-09-09",
        sourceUrl = "https://www.msit.go.kr/bbs/view.do?sCode=user&mId=311&mPid=121&bbsSeqNo=100&nttSeqNo=3186878",
    )
}
