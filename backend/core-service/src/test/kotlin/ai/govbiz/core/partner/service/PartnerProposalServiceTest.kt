package ai.govbiz.core.partner.service

import ai.govbiz.core.account.domain.CompanySummary
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.partner.domain.NewPartnerProposal
import ai.govbiz.core.partner.domain.PartnerProposal
import ai.govbiz.core.partner.domain.PartnerProposalDecision
import ai.govbiz.core.partner.domain.PartnerProposalInput
import ai.govbiz.core.partner.domain.PartnerProposalParty
import ai.govbiz.core.partner.domain.PartnerProposalRecruitment
import ai.govbiz.core.partner.domain.PartnerProposalStatus
import ai.govbiz.core.partner.domain.PartnerRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitmentCompany
import ai.govbiz.core.partner.domain.PartnerRecruitmentInput
import ai.govbiz.core.partner.domain.PartnerRecruitmentProgram
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.partner.repository.PartnerProposalRepository
import ai.govbiz.core.partner.repository.PartnerRecruitmentRepository
import ai.govbiz.core.partner.service.exception.CompanyRequiredException
import ai.govbiz.core.partner.service.exception.ProposalActionForbiddenException
import ai.govbiz.core.partner.service.exception.ProposalAlreadySentException
import ai.govbiz.core.partner.service.exception.ProposalNotFoundException
import ai.govbiz.core.partner.service.exception.ProposalNotPendingException
import ai.govbiz.core.partner.service.exception.ProposalToOwnRecruitmentException
import ai.govbiz.core.partner.service.exception.RecruitmentClosedException
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.ArgumentMatchers.anyLong
import org.mockito.Mock
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.dao.DuplicateKeyException

@ExtendWith(MockitoExtension::class)
class PartnerProposalServiceTest {

    @Mock
    private lateinit var proposalRepository: PartnerProposalRepository

    @Mock
    private lateinit var recruitmentRepository: PartnerRecruitmentRepository

    private lateinit var service: PartnerProposalService

    private val owner = AccountTestHelper.account(id = 7L, email = "owner@company.co.kr", company = CompanySummary(3L, "데이터브릿지 주식회사", "1248100998"))
    private val proposer = AccountTestHelper.account(id = 8L, email = "proposer@company.co.kr", company = CompanySummary(4L, "네이버 주식회사", "2208162517"))

    @BeforeEach
    fun setUp() {
        service = PartnerProposalService(proposalRepository, recruitmentRepository, AccountTestHelper.FIXED_CLOCK)
    }

    @Test
    fun sendAttachesTheSessionCompanyToAnOpenRecruitmentOfAnotherMember() {
        doReturn(recruitment()).`when`(recruitmentRepository).findById(21L)
        var created: NewPartnerProposal? = null
        doAnswer { invocation ->
            created = invocation.getArgument(0)
            proposal()
        }.`when`(proposalRepository).create(AccountTestHelper.anyValue())

        service.send(proposer, 21L, input())

        val newProposal = requireNotNull(created)
        assertEquals(21L, newProposal.recruitmentId)
        assertEquals(8L, newProposal.proposerAccountId)
        assertEquals(4L, newProposal.proposerCompanyId)
    }

    @Test
    fun sendRejectsMembersWithoutCompanyOwnersAndClosedRecruitments() {
        assertThrows(CompanyRequiredException::class.java) { service.send(AccountTestHelper.account(id = 9L), 21L, input()) }
        verify(recruitmentRepository, never()).findById(anyLong())

        doReturn(recruitment()).`when`(recruitmentRepository).findById(21L)
        assertThrows(ProposalToOwnRecruitmentException::class.java) { service.send(owner, 21L, input()) }

        doReturn(recruitment(recruitmentDeadline = LocalDate.of(2026, 9, 5))).`when`(recruitmentRepository).findById(22L)
        assertThrows(RecruitmentClosedException::class.java) { service.send(proposer, 22L, input()) }
        verify(proposalRepository, never()).create(AccountTestHelper.anyValue())
    }

    @Test
    fun sendTranslatesTheUniqueConstraintIntoAlreadySent() {
        doReturn(recruitment()).`when`(recruitmentRepository).findById(21L)
        doThrow(DuplicateKeyException("uq_partner_proposal_recruitment_proposer")).`when`(proposalRepository).create(AccountTestHelper.anyValue())

        assertThrows(ProposalAlreadySentException::class.java) { service.send(proposer, 21L, input()) }
    }

    @Test
    fun onlyPartiesReadAProposalAndOnlyTheOwnerDecides() {
        doReturn(proposal()).`when`(proposalRepository).findById(31L)
        assertThrows(ProposalNotFoundException::class.java) { service.find(AccountTestHelper.account(id = 9L), 31L) }
        assertEquals(31L, service.findView(proposer, 31L).proposal.id)

        assertThrows(ProposalActionForbiddenException::class.java) { service.accept(proposer, 31L) }
        assertThrows(ProposalActionForbiddenException::class.java) { service.withdraw(owner, 31L) }

        doReturn(proposal(decision = PartnerProposalDecision.ACCEPTED)).`when`(proposalRepository).decide(31L, PartnerProposalDecision.ACCEPTED)
        val accepted = service.accept(owner, 31L)
        assertEquals(PartnerProposalStatus.ACCEPTED, accepted.status)
        assertEquals(true, accepted.revealsContacts)
    }

    @Test
    fun expiredAndAlreadyHandledProposalsCannotBeDecidedOrWithdrawn() {
        doReturn(proposal(createdAt = NOW.minusDays(8))).`when`(proposalRepository).findById(31L)
        assertThrows(ProposalNotPendingException::class.java) { service.decline(owner, 31L) }
        assertThrows(ProposalNotPendingException::class.java) { service.withdraw(proposer, 31L) }
        verify(proposalRepository, never()).decide(anyLong(), AccountTestHelper.anyValue())

        // 조회 직후 다른 요청이 먼저 처리해 UPDATE가 0건이면 같은 예외로 알립니다.
        doReturn(proposal()).`when`(proposalRepository).findById(32L)
        doReturn(null).`when`(proposalRepository).withdraw(31L)
        assertThrows(ProposalNotPendingException::class.java) { service.withdraw(proposer, 32L) }
    }

    @Test
    fun statusFollowsResponseWithdrawalTimeAndRecruitmentClosure() {
        val pending = proposal()
        assertEquals(PartnerProposalStatus.PENDING, pending.status(NOW))
        assertEquals(PartnerProposalStatus.EXPIRED, pending.status(NOW.plusDays(7).plusMinutes(1)))
        assertEquals(PartnerProposalStatus.EXPIRED, pending.status(LocalDate.of(2026, 9, 21).atStartOfDay()))
        assertEquals(PartnerProposalStatus.WITHDRAWN, pending.copy(withdrawnAt = NOW).status(NOW))
        assertEquals(PartnerProposalStatus.DECLINED, pending.copy(decision = PartnerProposalDecision.DECLINED, respondedAt = NOW).status(NOW))
        val accepted = pending.copy(decision = PartnerProposalDecision.ACCEPTED, respondedAt = NOW)
        assertEquals(PartnerProposalStatus.ACCEPTED, accepted.status(NOW.plusDays(30)))
        assertEquals(true, accepted.revealsContacts(NOW))
        assertEquals(false, pending.revealsContacts(NOW))
    }

    private fun input() = PartnerProposalInput(message = "라벨링 운영을 맡겠습니다.", shareProfile = true)

    private fun program() =
        PartnerRecruitmentProgram(
            id = 11L,
            sourceCode = "BIZINFO",
            sourceProgramId = "PBLN-1",
            title = "서울 AI 스타트업 실증 지원사업",
            organization = "서울경제진흥원",
            summary = "실증 과제를 지원합니다.",
            targetDescription = "서울 소재 AI 기업",
            applicationPeriod = "2026-09-01 ~ 2026-09-30",
            applicationStartDate = LocalDate.of(2026, 9, 1),
            applicationEndDate = LocalDate.of(2026, 9, 30),
            sourceUrl = "https://www.bizinfo.go.kr",
        )

    private fun recruitment(recruitmentDeadline: LocalDate = LocalDate.of(2026, 9, 20)) =
        PartnerRecruitment(
            id = 21L,
            accountId = 7L,
            company = PartnerRecruitmentCompany("데이터브릿지 주식회사", "서울특별시", "정보통신업", 2021, isEmailVerified = false),
            program = program(),
            content = PartnerRecruitmentInput(
                title = "AI 실증 참여기관 구합니다",
                body = "본문",
                ownRole = PartnerRole.LEAD,
                seekingRole = PartnerRole.PARTICIPANT,
                seekingCount = 1,
                region = "서울",
                minimumCompanyAgeYears = null,
                capabilities = emptyList(),
                recruitmentDeadline = recruitmentDeadline,
            ),
            closedAt = null,
            createdAt = NOW,
            updatedAt = NOW,
        )

    private fun proposal(decision: PartnerProposalDecision? = null, createdAt: java.time.LocalDateTime = NOW) =
        PartnerProposal(
            id = 31L,
            recruitment = PartnerProposalRecruitment(21L, "AI 실증 참여기관 구합니다", LocalDate.of(2026, 9, 20), null, program()),
            proposer = PartnerProposalParty(8L, "proposer@company.co.kr", "네이버 주식회사", "2208162517", "경기도", "정보통신업", 1999, null, isEmailVerified = false),
            owner = PartnerProposalParty(7L, "owner@company.co.kr", "데이터브릿지 주식회사", "1248100998", "서울특별시", "정보통신업", 2021, null, isEmailVerified = true),
            content = input(),
            decision = decision,
            respondedAt = if (decision == null) null else NOW,
            withdrawnAt = null,
            createdAt = createdAt,
            updatedAt = createdAt,
        )
}
