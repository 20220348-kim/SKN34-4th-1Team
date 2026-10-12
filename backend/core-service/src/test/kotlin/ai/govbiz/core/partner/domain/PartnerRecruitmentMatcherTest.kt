package ai.govbiz.core.partner.domain

import java.time.LocalDate
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PartnerRecruitmentMatcherTest {
    private val today = LocalDate.of(2026, 10, 12)
    private val now = LocalDateTime.of(2026, 10, 12, 9, 0)

    private fun program(id: String = "P-1", title: String = "AI 실증 지원사업", end: LocalDate? = LocalDate.of(2026, 12, 31)) =
        PartnerRecruitmentProgram(
            id = 1L, sourceCode = "BIZINFO", sourceProgramId = id, title = title, organization = "기관",
            summary = "", targetDescription = "", applicationPeriod = "", applicationStartDate = null,
            applicationEndDate = end, sourceUrl = "https://www.bizinfo.go.kr",
        )

    private fun recruitment(
        id: Long,
        accountId: Long = 100L + id,
        seekingRole: PartnerRole = PartnerRole.PARTICIPANT,
        region: String = "전국",
        minimumAge: Int? = null,
        capabilities: List<String> = emptyList(),
        title: String = "모집글 $id",
        body: String = "본문",
        deadline: LocalDate = LocalDate.of(2026, 10, 30),
        programId: String = "P-$id",
        programTitle: String = "공고 $id",
        closedAt: LocalDateTime? = null,
    ) = PartnerRecruitment(
        id = id, accountId = accountId,
        company = PartnerRecruitmentCompany("회사 $id", "서울특별시", "정보통신업", 2020, isEmailVerified = true),
        program = program(programId, programTitle),
        content = PartnerRecruitmentInput(
            title = title, body = body, ownRole = PartnerRole.LEAD, seekingRole = seekingRole, seekingCount = 1, region = region,
            minimumCompanyAgeYears = minimumAge, capabilities = capabilities, recruitmentDeadline = deadline,
        ),
        closedAt = closedAt, createdAt = now, updatedAt = now,
    )

    private fun applicant(
        roles: Set<PartnerRole> = setOf(PartnerRole.PARTICIPANT),
        capabilities: List<String> = emptyList(),
        programs: List<PartnerMatchMyProgram> = emptyList(),
        region: String? = "서울",
        foundedYear: Int? = 2020,
        proposed: Set<Long> = emptySet(),
    ) = PartnerMatchApplicant(7L, region, foundedYear, roles, capabilities, programs, proposed)

    private fun saved(id: String, title: String = "관심 공고", open: Boolean = true) =
        PartnerMatchMyProgram(PartnerMatchProgram("BIZINFO", id), title, PartnerMatchProgramSource.SAVED, open)

    @Test
    fun excludesClosedOwnProposedRoleMismatchAndTooYoungWithoutFilteringOtherRegions() {
        val candidates = listOf(
            recruitment(1, closedAt = now),
            recruitment(2, accountId = 7L),
            recruitment(3),
            recruitment(4, seekingRole = PartnerRole.DEMAND),
            recruitment(5, minimumAge = 10),
            recruitment(6, region = "부산"),
            recruitment(7, minimumAge = 6),
        )
        val result = PartnerRecruitmentMatcher.match(candidates, applicant(proposed = setOf(3L)), PartnerMatchConditions(), today, limit = 10)

        assertEquals(listOf(6L, 7L).toSet(), result.matches.map { it.recruitment.id }.toSet())
        // 희망 지역이 달라도 거르지 않고 확인할 점으로만 알립니다.
        val other = result.matches.single { it.recruitment.id == 6L }
        assertEquals(listOf(PartnerMatchCaution(PartnerMatchCautionType.OTHER_REGION, "부산")), other.cautions)
        // 다른 이유가 없으면 찾는 역할이 맞다는 이유만 붙습니다.
        assertEquals(listOf(PartnerMatchReason(PartnerMatchReasonType.ROLE, listOf("PARTICIPANT"))), other.reasons)
    }

    @Test
    fun ranksMyProgramsKeywordsCapabilitiesAndRegionAndTiesByDeadline() {
        val candidates = listOf(
            recruitment(1, deadline = LocalDate.of(2026, 10, 20)),
            recruitment(2, capabilities = listOf("데이터 구축", "라벨링", "품질 검수"), region = "서울", deadline = LocalDate.of(2026, 10, 25)),
            recruitment(3, programId = "SAVED-1", programTitle = "관심 공고"),
            recruitment(4, deadline = LocalDate.of(2026, 10, 15)),
        )
        val me = applicant(capabilities = listOf("데이터구축", "라벨링 운영"), programs = listOf(saved("SAVED-1")))
        val result = PartnerRecruitmentMatcher.match(candidates, me, PartnerMatchConditions(), today, limit = 10)

        assertEquals(listOf(2L, 3L, 4L, 1L), result.matches.map { it.recruitment.id })
        assertEquals(3, result.matches[0].score)
        assertEquals(
            listOf(
                PartnerMatchReason(PartnerMatchReasonType.CAPABILITY, listOf("데이터 구축", "라벨링")),
                PartnerMatchReason(PartnerMatchReasonType.SAME_REGION, listOf("서울")),
            ),
            result.matches[0].reasons,
        )
        assertEquals(
            PartnerMatchReason(PartnerMatchReasonType.MY_PROGRAM, listOf("관심 공고"), PartnerMatchProgramSource.SAVED),
            result.matches[1].reasons.single(),
        )
        assertEquals(4, result.total)
    }

    @Test
    fun spokenRolesRegionsAndProgramFilterWhileKeywordsOnlyRaiseTheOrder() {
        val candidates = listOf(
            recruitment(1, region = "서울"),
            recruitment(2, region = "전국", title = "AI 데이터 라벨링 참여기관"),
            recruitment(3, region = "부산"),
            recruitment(4, region = "서울", seekingRole = PartnerRole.LEAD),
        )
        val me = applicant(roles = setOf(PartnerRole.PARTICIPANT, PartnerRole.LEAD))
        val conditions = PartnerMatchConditions(setOf(PartnerRole.PARTICIPANT), setOf("서울"), listOf("AI"))
        val result = PartnerRecruitmentMatcher.match(candidates, me, conditions, today, limit = 10)

        // 지역을 고르면 전국 모집글도 남고, 분야 말은 거르지 않고 순서만 올립니다.
        assertEquals(listOf(2L, 1L), result.matches.map { it.recruitment.id })
        assertEquals(PartnerMatchReason(PartnerMatchReasonType.KEYWORD, listOf("AI")), result.matches[0].reasons.first())
        assertEquals(
            listOf(PartnerMatchRelax(PartnerMatchRelaxType.ROLE, 3), PartnerMatchRelax(PartnerMatchRelaxType.REGION, 3)),
            result.relax,
        )

        val byProgram = PartnerRecruitmentMatcher.match(
            candidates, me, PartnerMatchConditions(program = PartnerMatchProgram("BIZINFO", "P-3")), today, limit = 10,
        )
        assertEquals(listOf(3L), byProgram.matches.map { it.recruitment.id })
        assertEquals(listOf(PartnerMatchRelax(PartnerMatchRelaxType.PROGRAM, 4)), byProgram.relax)
    }

    @Test
    fun withoutProfileOrCompanyNothingIsFilteredByRoleOrAgeAndTheAgeIsLeftToConfirm() {
        val candidates = listOf(recruitment(1, seekingRole = PartnerRole.DEMAND, minimumAge = 5))
        val result = PartnerRecruitmentMatcher.match(
            candidates, applicant(roles = emptySet(), region = null, foundedYear = null), PartnerMatchConditions(), today, limit = 3,
        )
        val match = result.matches.single()
        assertTrue(match.reasons.isEmpty())
        assertEquals(listOf(PartnerMatchCaution(PartnerMatchCautionType.COMPANY_AGE, "5")), match.cautions)
    }

    @Test
    fun suggestsAnOpenSavedProgramThatNobodyRecruitsForYet() {
        val candidates = listOf(recruitment(1, programId = "TAKEN"))
        val programs = listOf(saved("CLOSED", open = false), saved("TAKEN"), saved("FREE", title = "빈 공고"))
        val result = PartnerRecruitmentMatcher.match(candidates, applicant(programs = programs), PartnerMatchConditions(), today, limit = 3)
        assertEquals("빈 공고", result.suggestedProgram?.title)

        val none = PartnerRecruitmentMatcher.match(candidates, applicant(programs = programs.take(2)), PartnerMatchConditions(), today, limit = 3)
        assertNull(none.suggestedProgram)
    }

    @Test
    fun limitsTheReturnedMatchesButReportsTheTotal() {
        val candidates = (1L..5L).map { recruitment(it) }
        val result = PartnerRecruitmentMatcher.match(candidates, applicant(), PartnerMatchConditions(), today, limit = 3)
        assertEquals(3, result.matches.size)
        assertEquals(5, result.total)
    }
}
