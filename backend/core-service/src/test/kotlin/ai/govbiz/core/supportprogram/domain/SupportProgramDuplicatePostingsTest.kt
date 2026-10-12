package ai.govbiz.core.supportprogram.domain

import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class SupportProgramDuplicatePostingsTest {

    @Test
    fun keepsOneSlotForTheSameProgramPostedByTwoSourcesAtTheHigherRank() {
        val bizInfo = program("PBLN_1", "BIZINFO", "[서울] 2026년 AI 창업 지원사업 모집 공고")
        val other = program("PBLN_2", "BIZINFO", "부산 수출 지원")
        val kStartup = program("179197", "KSTARTUP", "2026년 AI 창업지원사업 모집공고")
        val ranked = listOf(bizInfo, other, kStartup)

        val grouped = SupportProgramDuplicatePostings.group(ranked, ranked)

        assertEquals(listOf("BIZINFO:PBLN_1", "BIZINFO:PBLN_2"), grouped.map(SupportProgram::sourceQualifiedId))
        assertEquals(listOf(SupportProgramPosting("KSTARTUP", "179197", "K-Startup", kStartup.sourceUrl)), grouped[0].alsoPostedBy)
        assertEquals(emptyList<SupportProgramPosting>(), grouped[1].alsoPostedBy)
        // 앞선 칸의 점수·이유·자격 판정은 그대로입니다.
        assertEquals(bizInfo.copy(alsoPostedBy = grouped[0].alsoPostedBy), grouped[0])
    }

    @Test
    fun attachesAPostingFoundOnlyInTheSearchPoolWithoutChangingRankedSlots() {
        val kStartup = program("179197", "KSTARTUP", "청년 창업 사관학교（2026）", organization = "창업 진흥원")
        val bizInfo = program("PBLN_1", "BIZINFO", "【전국】청년 창업 사관학교 2026", organization = "창업진흥원")

        val grouped = SupportProgramDuplicatePostings.group(listOf(kStartup), listOf(kStartup, bizInfo))

        assertEquals(listOf("KSTARTUP:179197"), grouped.map(SupportProgram::sourceQualifiedId))
        assertEquals(listOf("BIZINFO:PBLN_1"), grouped.single().alsoPostedBy.map { "${it.sourceCode}:${it.id}" })
    }

    @Test
    fun doesNotGroupWhenOrganizationDeadlineOrSourceDiffersOrOrganizationIsUnknown() {
        val base = program("PBLN_1", "BIZINFO", "AI 창업 지원")
        val cases = listOf(
            program("1", "KSTARTUP", "AI 창업 지원", organization = "다른기관"),
            program("2", "KSTARTUP", "AI 창업 지원", endDate = LocalDate.of(2026, 10, 30)),
            program("3", "KSTARTUP", "AI 창업 지원 2차"),
            program("PBLN_9", "BIZINFO", "AI 창업 지원"),
        )
        for (candidate in cases) {
            val grouped = SupportProgramDuplicatePostings.group(listOf(base, candidate), emptyList())
            assertEquals(listOf(base, candidate), grouped, candidate.sourceQualifiedId)
        }
        for (organization in listOf("정보 없음", "직접수행", " ")) {
            val unknown = listOf(base.copy(organization = organization), program("1", "KSTARTUP", "AI 창업 지원", organization = organization))
            assertEquals(unknown, SupportProgramDuplicatePostings.group(unknown, emptyList()), organization)
        }
    }

    @Test
    fun doesNotGroupProgramsWhoseTitlePrefixesNameDifferentRegions() {
        // 같은 기관이 같은 마감일로 지역마다 낸 공고는 제목 본문이 같아도 다른 공고입니다.
        val seoul = program("PBLN_1", "BIZINFO", "[서울] 2026년 수출 바우처 모집")
        val busan = program("1", "KSTARTUP", "[부산] 2026년 수출 바우처 모집")
        assertEquals(listOf(seoul, busan), SupportProgramDuplicatePostings.group(listOf(seoul, busan), emptyList()))

        // 머리말이 한쪽에만 있거나 같은 지역(약칭·정식명)이면 같은 공고로 묶습니다.
        for (title in listOf("2026년 수출 바우처 모집", "[서울특별시] 2026년 수출 바우처 모집", "[서울·경기] 2026년 수출 바우처 모집")) {
            val kStartup = program("2", "KSTARTUP", title)
            val grouped = SupportProgramDuplicatePostings.group(listOf(seoul, kStartup), emptyList())
            assertEquals(listOf("KSTARTUP:2"), grouped.single().alsoPostedBy.map { "${it.sourceCode}:${it.id}" }, title)
        }
    }

    @Test
    fun attachesOnePostingPerOtherSourceAndNeverTheSamePostingTwice() {
        val bizInfo = program("PBLN_1", "BIZINFO", "AI 창업 지원")
        val kStartup = program("1", "KSTARTUP", "AI 창업 지원")
        val secondKStartup = program("2", "KSTARTUP", "AI 창업 지원")
        val msit = program("M1", "MSIT", "AI 창업 지원")

        val grouped = SupportProgramDuplicatePostings.group(listOf(bizInfo, secondKStartup), listOf(kStartup, msit))

        assertEquals(listOf("BIZINFO:PBLN_1"), grouped.map(SupportProgram::sourceQualifiedId))
        assertEquals(listOf("KSTARTUP:2", "MSIT:M1"), grouped.single().alsoPostedBy.map { "${it.sourceCode}:${it.id}" })
        assertThrows(UnsupportedOperationException::class.java) {
            (grouped as MutableList<SupportProgram>).add(bizInfo)
        }
    }

    private fun program(
        id: String,
        sourceCode: String,
        title: String,
        organization: String = "창업진흥원",
        endDate: LocalDate? = LocalDate.of(2026, 10, 31),
    ) = SupportProgram(
        id = id,
        sourceCode = sourceCode,
        title = title,
        organization = organization,
        summary = "요약",
        categories = emptyList(),
        regions = listOf("서울"),
        targetDescription = "중소기업",
        applicationPeriod = "2026-10-01 ~ 2026-10-31",
        applicationStartDate = LocalDate.of(2026, 10, 1),
        applicationEndDate = endDate,
        status = SupportProgramStatus.OPEN,
        sourceName = mapOf("BIZINFO" to "기업마당", "KSTARTUP" to "K-Startup").getOrDefault(sourceCode, sourceCode),
        sourceUrl = "https://${sourceCode.lowercase()}.example/detail?id=$id",
        matchedReasons = listOf("관련 이유"),
        recommendationScore = 80,
    )
}
