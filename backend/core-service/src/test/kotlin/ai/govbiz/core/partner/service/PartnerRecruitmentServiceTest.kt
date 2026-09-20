package ai.govbiz.core.partner.service

import ai.govbiz.core.account.domain.CompanySummary
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.partner.domain.NewPartnerRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitmentCompany
import ai.govbiz.core.partner.domain.PartnerRecruitmentInput
import ai.govbiz.core.partner.domain.PartnerRecruitmentProgram
import ai.govbiz.core.partner.domain.PartnerRecruitmentStatus
import ai.govbiz.core.partner.domain.PartnerRecruitmentView
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.partner.repository.PartnerProposalRepository
import ai.govbiz.core.partner.repository.PartnerRecruitmentRepository
import ai.govbiz.core.partner.service.exception.CompanyRequiredException
import ai.govbiz.core.partner.service.exception.RecruitmentActionForbiddenException
import ai.govbiz.core.partner.service.exception.RecruitmentAlreadyExistsException
import ai.govbiz.core.partner.service.exception.RecruitmentClosedException
import ai.govbiz.core.partner.service.exception.RecruitmentDeadlineNotAllowedException
import ai.govbiz.core.partner.service.exception.RecruitmentNotFoundException
import ai.govbiz.core.partner.service.exception.RecruitmentProgramClosedException
import ai.govbiz.core.partner.service.exception.RecruitmentProgramNotFoundException
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.ArgumentMatchers.anyLong
import org.mockito.ArgumentMatchers.eq
import org.mockito.Mock
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.dao.DuplicateKeyException

@ExtendWith(MockitoExtension::class)
class PartnerRecruitmentServiceTest {

    @Mock
    private lateinit var recruitmentRepository: PartnerRecruitmentRepository

    @Mock
    private lateinit var proposalRepository: PartnerProposalRepository

    private lateinit var service: PartnerRecruitmentService

    private val companyAccount = AccountTestHelper.account(
        id = 7L,
        company = CompanySummary(id = 3L, companyName = "데이터브릿지 주식회사", businessNumber = "1248100998"),
    )

    @BeforeEach
    fun setUp() {
        service = PartnerRecruitmentService(recruitmentRepository, proposalRepository, AccountTestHelper.FIXED_CLOCK)
    }

    @Test
    fun createAttachesTheSessionCompanyAndTheVerifiedProgram() {
        doReturn(program()).`when`(recruitmentRepository).findPresentProgram("BIZINFO", "PBLN-1")
        var created: NewPartnerRecruitment? = null
        doAnswer { invocation ->
            created = invocation.getArgument(0)
            recruitment()
        }.`when`(recruitmentRepository).create(AccountTestHelper.anyValue())

        val view: PartnerRecruitmentView = service.create(companyAccount, "BIZINFO", "PBLN-1", input())

        assertEquals(PartnerRecruitmentStatus.OPEN, view.status)
        assertEquals(0, view.proposalCount)
        val newRecruitment = requireNotNull(created)
        assertEquals(7L, newRecruitment.accountId)
        assertEquals(3L, newRecruitment.companyId)
        assertEquals(11L, newRecruitment.supportProgramId)
        assertEquals("AI 실증 참여기관 구합니다", newRecruitment.content.title)
    }

    @Test
    fun createRejectsMembersWithoutACompanyBeforeTouchingTheDatabase() {
        assertThrows(CompanyRequiredException::class.java) {
            service.create(AccountTestHelper.account(id = 8L), "BIZINFO", "PBLN-1", input())
        }
        verify(recruitmentRepository, never()).findPresentProgram(AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
    }

    @Test
    fun createRejectsUnknownAndClosedPrograms() {
        doReturn(null).`when`(recruitmentRepository).findPresentProgram("BIZINFO", "missing")
        assertThrows(RecruitmentProgramNotFoundException::class.java) {
            service.create(companyAccount, "BIZINFO", "missing", input())
        }

        doReturn(program(applicationEndDate = LocalDate.of(2026, 9, 5))).`when`(recruitmentRepository)
            .findPresentProgram("BIZINFO", "closed")
        assertThrows(RecruitmentProgramClosedException::class.java) {
            service.create(companyAccount, "BIZINFO", "closed", input())
        }
        verify(recruitmentRepository, never()).create(AccountTestHelper.anyValue())
    }

    @Test
    fun createAllowsDeadlinesFromTodayUntilTheDayBeforeTheProgramDeadline() {
        doReturn(program()).`when`(recruitmentRepository).findPresentProgram("BIZINFO", "PBLN-1")

        val tooEarly = assertThrows(RecruitmentDeadlineNotAllowedException::class.java) {
            service.create(companyAccount, "BIZINFO", "PBLN-1", input(recruitmentDeadline = LocalDate.of(2026, 9, 5)))
        }
        assertEquals(LocalDate.of(2026, 9, 29), tooEarly.latestAllowedDeadline)
        assertThrows(RecruitmentDeadlineNotAllowedException::class.java) {
            service.create(companyAccount, "BIZINFO", "PBLN-1", input(recruitmentDeadline = LocalDate.of(2026, 9, 30)))
        }
        verify(recruitmentRepository, never()).create(AccountTestHelper.anyValue())

        doReturn(recruitment()).`when`(recruitmentRepository).create(AccountTestHelper.anyValue())
        service.create(companyAccount, "BIZINFO", "PBLN-1", input(recruitmentDeadline = LocalDate.of(2026, 9, 6)))
        service.create(companyAccount, "BIZINFO", "PBLN-1", input(recruitmentDeadline = LocalDate.of(2026, 9, 29)))
    }

    @Test
    fun createDoesNotLimitTheDeadlineWhenTheProgramHasNoEndDate() {
        doReturn(program(applicationEndDate = null, applicationPeriod = "예산 소진 시까지")).`when`(recruitmentRepository)
            .findPresentProgram("BIZINFO", "PBLN-1")
        doReturn(recruitment()).`when`(recruitmentRepository).create(AccountTestHelper.anyValue())

        service.create(companyAccount, "BIZINFO", "PBLN-1", input(recruitmentDeadline = LocalDate.of(2027, 3, 1)))

        val tooEarly = assertThrows(RecruitmentDeadlineNotAllowedException::class.java) {
            service.create(companyAccount, "BIZINFO", "PBLN-1", input(recruitmentDeadline = LocalDate.of(2026, 9, 5)))
        }
        assertNull(tooEarly.latestAllowedDeadline)
    }

    @Test
    fun createTranslatesTheUniqueConstraintIntoAlreadyExists() {
        doReturn(program()).`when`(recruitmentRepository).findPresentProgram("BIZINFO", "PBLN-1")
        doThrow(DuplicateKeyException("uq_partner_recruitment_account_program")).`when`(recruitmentRepository)
            .create(AccountTestHelper.anyValue())

        assertThrows(RecruitmentAlreadyExistsException::class.java) {
            service.create(companyAccount, "BIZINFO", "PBLN-1", input())
        }
    }

    @Test
    fun updateAndCloseRejectOtherMembersAndClosedRecruitments() {
        doReturn(recruitment()).`when`(recruitmentRepository).findById(21L)
        assertThrows(RecruitmentActionForbiddenException::class.java) {
            service.update(AccountTestHelper.account(id = 8L), 21L, input())
        }
        assertThrows(RecruitmentActionForbiddenException::class.java) { service.close(AccountTestHelper.account(id = 8L), 21L) }

        doReturn(recruitment().copy(closedAt = NOW)).`when`(recruitmentRepository).findById(22L)
        assertThrows(RecruitmentClosedException::class.java) { service.update(companyAccount, 22L, input()) }
        assertThrows(RecruitmentClosedException::class.java) { service.close(companyAccount, 22L) }
        verify(recruitmentRepository, never()).update(anyLong(), AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
        verify(recruitmentRepository, never()).close(anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun updateKeepsTheDeadlineRuleAndReturnsTheRefreshedView() {
        doReturn(recruitment()).`when`(recruitmentRepository).findById(21L)
        assertThrows(RecruitmentDeadlineNotAllowedException::class.java) {
            service.update(companyAccount, 21L, input(recruitmentDeadline = LocalDate.of(2026, 9, 30)))
        }

        val edited = input(recruitmentDeadline = LocalDate.of(2026, 9, 25))
        doReturn(recruitment().copy(content = edited)).`when`(recruitmentRepository)
            .update(eq(21L), AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
        doReturn(null).`when`(proposalRepository).findByRecruitmentAndProposer(21L, 7L)
        doReturn(mapOf(21L to 2)).`when`(proposalRepository).countByRecruitmentIds(listOf(21L))

        val view = service.update(companyAccount, 21L, edited)

        assertEquals(2, view.proposalCount)
        verify(recruitmentRepository).update(eq(21L), AccountTestHelper.anyValue(), AccountTestHelper.anyValue())
    }

    @Test
    fun closeMarksTheRecruitmentClosedAndRereadsIt() {
        doReturn(recruitment()).`when`(recruitmentRepository).findById(21L)
        doReturn(recruitment().copy(closedAt = NOW)).`when`(recruitmentRepository).close(eq(21L), AccountTestHelper.anyValue())
        doReturn(null).`when`(proposalRepository).findByRecruitmentAndProposer(21L, 7L)
        doReturn(emptyMap<Long, Int>()).`when`(proposalRepository).countByRecruitmentIds(listOf(21L))

        service.close(companyAccount, 21L)

        verify(recruitmentRepository).close(eq(21L), AccountTestHelper.anyValue())
    }

    @Test
    fun findFailsWhenTheRecruitmentIsMissing() {
        doReturn(null).`when`(recruitmentRepository).findById(99L)
        assertThrows(RecruitmentNotFoundException::class.java) { service.find(99L) }
    }

    @Test
    fun statusClosesWhenTheDeadlineOrTheProgramHasPassed() {
        val open = recruitment()
        assertEquals(PartnerRecruitmentStatus.OPEN, open.status(LocalDate.of(2026, 9, 20)))
        assertEquals(PartnerRecruitmentStatus.CLOSED, open.status(LocalDate.of(2026, 9, 21)))
        assertEquals(PartnerRecruitmentStatus.CLOSED, open.copy(closedAt = NOW).status(LocalDate.of(2026, 9, 6)))
        assertEquals(
            PartnerRecruitmentStatus.CLOSED,
            open.copy(program = program(applicationEndDate = LocalDate.of(2026, 9, 10)), content = input(recruitmentDeadline = LocalDate.of(2026, 9, 9)))
                .status(LocalDate.of(2026, 9, 11)),
        )
    }

    private fun input(recruitmentDeadline: LocalDate = LocalDate.of(2026, 9, 20)) =
        PartnerRecruitmentInput(
            title = "AI 실증 참여기관 구합니다",
            body = "라벨링 운영을 맡아 주실 참여기관을 찾습니다.",
            ownRole = PartnerRole.LEAD,
            seekingRole = PartnerRole.PARTICIPANT,
            seekingCount = 1,
            region = "서울",
            minimumCompanyAgeYears = null,
            capabilities = listOf("데이터 구축", "라벨링"),
            recruitmentDeadline = recruitmentDeadline,
        )

    private fun program(
        applicationEndDate: LocalDate? = LocalDate.of(2026, 9, 30),
        applicationPeriod: String = "2026-09-01 ~ 2026-09-30",
    ) =
        PartnerRecruitmentProgram(
            id = 11L,
            sourceCode = "BIZINFO",
            sourceProgramId = "PBLN-1",
            title = "서울 AI 스타트업 실증 지원사업",
            organization = "서울경제진흥원",
            summary = "실증 과제를 지원합니다.",
            targetDescription = "서울 소재 AI 기업",
            applicationPeriod = applicationPeriod,
            applicationStartDate = LocalDate.of(2026, 9, 1),
            applicationEndDate = applicationEndDate,
            sourceUrl = "https://www.bizinfo.go.kr",
        )

    private fun recruitment() =
        PartnerRecruitment(
            id = 21L,
            accountId = 7L,
            company = PartnerRecruitmentCompany("데이터브릿지 주식회사", "서울특별시", "정보통신업", 2021, isEmailVerified = false),
            program = program(),
            content = input(),
            closedAt = null,
            createdAt = NOW,
            updatedAt = NOW,
        )
}
