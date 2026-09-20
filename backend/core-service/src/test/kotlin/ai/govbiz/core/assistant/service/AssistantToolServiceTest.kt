package ai.govbiz.core.assistant.service

import ai.govbiz.core.account.domain.Company
import ai.govbiz.core.account.domain.CompanyPartnerProfile
import ai.govbiz.core.account.domain.CompanyPartnerProfileInput
import ai.govbiz.core.account.domain.CompanyProfileInput
import ai.govbiz.core.account.repository.CompanyPartnerProfileRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.partner.domain.PartnerRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitmentCompany
import ai.govbiz.core.partner.domain.PartnerRecruitmentInput
import ai.govbiz.core.partner.domain.PartnerRecruitmentPage
import ai.govbiz.core.partner.domain.PartnerRecruitmentProgram
import ai.govbiz.core.partner.domain.PartnerRecruitmentQuery
import ai.govbiz.core.partner.domain.PartnerRecruitmentSort
import ai.govbiz.core.partner.domain.PartnerRecruitmentStatus
import ai.govbiz.core.partner.domain.PartnerRecruitmentView
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.partner.service.PartnerRecruitmentService
import ai.govbiz.core.supportprogram.domain.SavedSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.saved.SavedSupportProgramService
import java.time.LocalDate
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito
import org.mockito.Mockito.`when`

class AssistantToolServiceTest {
    private val companies = Mockito.mock(CompanyRepository::class.java)
    private val partnerProfiles = Mockito.mock(CompanyPartnerProfileRepository::class.java)
    private val recruitments = Mockito.mock(PartnerRecruitmentService::class.java)
    private val savedPrograms = Mockito.mock(SavedSupportProgramService::class.java)
    private val supportPrograms = Mockito.mock(SupportProgramRepository::class.java)
    private val service = AssistantToolService(companies, partnerProfiles, recruitments, savedPrograms, supportPrograms)
    private val queries = mutableListOf<PartnerRecruitmentQuery>()

    @Test
    fun companyProfileIsNotRegisteredWithoutACompany() {
        `when`(companies.findByAccountId(7L)).thenReturn(null)
        assertEquals(ai.govbiz.core.assistant.domain.AssistantCompanyProfile.NOT_REGISTERED, service.companyProfile(7L))
        Mockito.verifyNoInteractions(partnerProfiles)
    }

    @Test
    fun companyProfileCarriesProfileAndPartnerFieldsButNoContactOrBusinessNumber() {
        `when`(companies.findByAccountId(7L)).thenReturn(company())
        val introduction = "연락은 010-1234-5678 또는 lead@example.com 으로 주세요. " + "가".repeat(300)
        `when`(partnerProfiles.findByCompanyId(31L)).thenReturn(
            CompanyPartnerProfile(31L, CompanyPartnerProfileInput(listOf(PartnerRole.LEAD, PartnerRole.PARTICIPANT), listOf("AI", "데이터"), introduction.take(200), listOf("라벨링")), NOW),
        )

        val profile = service.companyProfile(7L)

        assertTrue(profile.registered)
        assertEquals("데이터브릿지 주식회사", profile.companyName)
        assertEquals("서울특별시", profile.region)
        assertEquals("정보통신업", profile.industry)
        assertEquals(2021, profile.foundedYear)
        assertEquals(listOf("LEAD", "PARTICIPANT"), profile.roles)
        assertEquals(listOf("AI", "데이터"), profile.interestAreas)
        assertEquals(listOf("라벨링"), profile.capabilities)
        val text = profile.introduction!!
        assertFalse(text.contains("010-1234-5678"), "전화번호는 가려집니다")
        assertFalse(text.contains("lead@example.com"), "이메일은 가려집니다")
        assertTrue(text.length <= AssistantToolService.INTRODUCTION_MAX + 1)
        assertFalse(profile.toString().contains("2208162517"), "사업자등록번호는 어디에도 없습니다")
    }

    @Test
    fun companyProfileWithoutPartnerInputHasEmptyPartnerFields() {
        `when`(companies.findByAccountId(7L)).thenReturn(company())
        `when`(partnerProfiles.findByCompanyId(31L)).thenReturn(CompanyPartnerProfile(31L, null, null))

        val profile = service.companyProfile(7L)

        assertTrue(profile.registered)
        assertEquals(emptyList<String>(), profile.roles)
        assertNull(profile.introduction)
    }

    @Test
    fun recruitmentSearchKeepsOnlyOpenPostsOfOthersAndClipsBodies() {
        val mine = recruitment(id = 1L, accountId = 7L)
        val closed = recruitment(id = 2L, accountId = 8L)
        val open = recruitment(id = 3L, accountId = 9L, body = "담당자 kim@partner.co.kr 010-9999-8888 " + "나".repeat(700))
        stubPage(listOf(view(mine, PartnerRecruitmentStatus.OPEN), view(closed, PartnerRecruitmentStatus.CLOSED), view(open, PartnerRecruitmentStatus.OPEN)))

        val result = service.searchRecruitments(7L, " 서울 ", "PARTICIPANT", "  실증 ")

        assertEquals(listOf(3L), result.map { it.id })
        val summary = result.single()
        assertEquals("AI 실증 참여기관 구합니다", summary.title)
        assertEquals("데이터브릿지 주식회사", summary.companyName)
        assertEquals("LEAD", summary.ownRole)
        assertEquals("PARTICIPANT", summary.seekingRole)
        assertEquals(LocalDate.of(2026, 9, 20), summary.recruitmentDeadline)
        assertEquals(LocalDate.of(2026, 9, 30), summary.programApplicationEndDate)
        assertFalse(summary.body.contains("kim@partner.co.kr"))
        assertFalse(summary.body.contains("010-9999-8888"))
        assertTrue(summary.body.endsWith("…"))
        assertTrue(summary.body.length <= AssistantToolService.BODY_MAX + 1)

        val query = queries.single()
        assertEquals("실증", query.keyword)
        assertEquals(setOf(PartnerRole.PARTICIPANT), query.seekingRoles)
        assertEquals(setOf("서울"), query.regions)
        assertNull(query.mineAccountId)
        assertEquals(PartnerRecruitmentSort.DEADLINE, query.sort)
        assertEquals(PartnerRecruitmentQuery.MAX_PAGE_SIZE, query.pageSize)
    }

    @Test
    fun recruitmentSearchWithoutFiltersSendsEmptyConditionsAndCapsTheList() {
        stubPage((1..40).map { view(recruitment(id = it.toLong(), accountId = 100L + it), PartnerRecruitmentStatus.OPEN) })

        val result = service.searchRecruitments(7L, null, null, null)

        assertEquals(AssistantToolService.RECRUITMENT_MAX, result.size)
        val query = queries.single()
        assertEquals("", query.keyword)
        assertTrue(query.seekingRoles.isEmpty())
        assertTrue(query.regions.isEmpty())
    }

    @Test
    fun recruitmentSearchWithAnUnknownRoleReturnsNothingWithoutQuerying() {
        assertEquals(emptyList<Any>(), service.searchRecruitments(7L, null, "OWNER", null))
        Mockito.verifyNoInteractions(recruitments)
    }

    @Test
    fun savedProgramsCarryADocumentIdOnlyWhenTheStoredSourceMatchesTheCurrentUrl() {
        val fresh = program("PBLN_000000000000001", "https://www.bizinfo.go.kr/1")
        val moved = program("PBLN_000000000000002", "https://www.bizinfo.go.kr/2-new")
        val missing = program("PBLN_000000000000003", "https://www.bizinfo.go.kr/3")
        val invalid = program("PBLN_000000000000004", "https://www.bizinfo.go.kr/4")
        `when`(savedPrograms.list(7L)).thenReturn(listOf(fresh, moved, missing, invalid).map { SavedSupportProgram(NOW, it) })
        `when`(supportPrograms.findPresentSourceDocument("BIZINFO", fresh.id)).thenReturn(document(fresh.id, fresh.sourceUrl))
        `when`(supportPrograms.findPresentSourceDocument("BIZINFO", moved.id)).thenReturn(document(moved.id, "https://www.bizinfo.go.kr/2-old"))
        `when`(supportPrograms.findPresentSourceDocument("BIZINFO", missing.id)).thenReturn(null)
        `when`(supportPrograms.findPresentSourceDocument("BIZINFO", invalid.id)).thenThrow(IllegalArgumentException("bad"))

        val result = service.savedPrograms(7L)

        assertEquals(listOf("BIZINFO:${fresh.id}", null, null, null), result.map { it.documentId })
        assertEquals(fresh.id, result.first().sourceProgramId)
        assertEquals("OPEN", result.first().status)
        assertEquals(LocalDate.of(2026, 9, 30), result.first().applicationEndDate)
    }

    @Test
    fun savedProgramsAreCappedAtTen() {
        `when`(savedPrograms.list(7L)).thenReturn((1..12).map { SavedSupportProgram(NOW, program("PBLN_%015d".format(it), "https://www.bizinfo.go.kr/$it")) })
        `when`(supportPrograms.findPresentSourceDocument(anyString(), anyString())).thenReturn(null)

        assertEquals(AssistantToolService.SAVED_MAX, service.savedPrograms(7L).size)
    }

    private fun stubPage(views: List<PartnerRecruitmentView>) {
        `when`(recruitments.findPage(any(PartnerRecruitmentQuery::class.java) ?: EMPTY_QUERY)).thenAnswer { invocation ->
            queries += invocation.getArgument<PartnerRecruitmentQuery>(0)
            PartnerRecruitmentPage(views, views.size.toLong(), 1, PartnerRecruitmentQuery.MAX_PAGE_SIZE)
        }
    }

    private fun company() = Company(
        31L, 7L, "2208162517", "데이터브릿지 주식회사", "계속사업자", "01",
        CompanyProfileInput("서울특별시", "정보통신업", 2021, null), NOW, NOW, NOW,
    )

    private fun program(id: String, sourceUrl: String) = SupportProgram(
        id, "BIZINFO", "서울 AI 실증 지원사업", "서울경제진흥원", "요약", emptyList(), emptyList(), "대상", "2026-09-01 ~ 2026-09-30",
        LocalDate.of(2026, 9, 1), LocalDate.of(2026, 9, 30), SupportProgramStatus.OPEN, "기업마당", sourceUrl, emptyList(),
    )

    private fun document(programId: String, sourceUrl: String): SupportProgramSourceDocument {
        val content = "<html>공고 원문 $programId</html>"
        return SupportProgramSourceDocument("BIZINFO", programId, sourceUrl, content, SupportProgramContentHashHelper.sha256(content), NOW)
    }

    private fun view(recruitment: PartnerRecruitment, status: PartnerRecruitmentStatus) = PartnerRecruitmentView(recruitment, status, 0, null)

    private fun recruitment(id: Long, accountId: Long, body: String = "라벨링 운영을 맡아 주실 참여기관을 찾습니다.") = PartnerRecruitment(
        id = id,
        accountId = accountId,
        company = PartnerRecruitmentCompany("데이터브릿지 주식회사", "서울특별시", "정보통신업", 2021, isEmailVerified = false),
        program = PartnerRecruitmentProgram(
            11L, "BIZINFO", "PBLN_000000000000001", "서울 AI 스타트업 실증 지원사업", "서울경제진흥원", "실증 과제를 지원합니다.", "서울 소재 AI 기업",
            "2026-09-01 ~ 2026-09-30", LocalDate.of(2026, 9, 1), LocalDate.of(2026, 9, 30), "https://www.bizinfo.go.kr",
        ),
        content = PartnerRecruitmentInput(
            title = "AI 실증 참여기관 구합니다", body = body, ownRole = PartnerRole.LEAD, seekingRole = PartnerRole.PARTICIPANT, seekingCount = 1,
            region = "서울", minimumCompanyAgeYears = null, capabilities = listOf("데이터 구축", "라벨링"), recruitmentDeadline = LocalDate.of(2026, 9, 20),
        ),
        closedAt = null,
        createdAt = NOW,
        updatedAt = NOW,
    )

    companion object {
        private val NOW = LocalDateTime.of(2026, 9, 10, 10, 0)
        private val EMPTY_QUERY = PartnerRecruitmentQuery("", emptySet(), emptySet(), null, PartnerRecruitmentSort.DEADLINE, 1, 1)
    }
}
