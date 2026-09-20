package ai.govbiz.core.account.service

import ai.govbiz.core.account.domain.AccountCredential
import ai.govbiz.core.account.domain.OAuthLink
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.account.repository.AccountOAuthUnlinkRepository
import ai.govbiz.core.account.service.dto.AccountDeletedEvent
import org.springframework.context.ApplicationEventPublisher
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.service.exception.CurrentPasswordMismatchException
import ai.govbiz.core.account.service.exception.LastAdminDeletionException
import ai.govbiz.core.partner.repository.PartnerProposalRepository
import ai.govbiz.core.partner.repository.PartnerRecruitmentRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.anyLong
import org.mockito.Mockito.anyString
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.inOrder
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder

@ExtendWith(MockitoExtension::class)
class AccountProfileServiceTest {

    @Mock
    private lateinit var accountRepository: AccountRepository

    @Mock
    private lateinit var companyRepository: CompanyRepository

    @Mock
    private lateinit var recruitmentRepository: PartnerRecruitmentRepository

    @Mock
    private lateinit var proposalRepository: PartnerProposalRepository

    @Mock
    private lateinit var unlinkRepository: AccountOAuthUnlinkRepository

    @Mock private lateinit var eventPublisher: ApplicationEventPublisher

    private val passwordEncoder = BCryptPasswordEncoder(4)

    private val account = AccountTestHelper.account(id = 7L)

    private lateinit var service: AccountProfileService

    @BeforeEach
    fun setUp() {
        service = AccountProfileService(
            accountRepository, companyRepository, recruitmentRepository, proposalRepository, passwordEncoder, unlinkRepository, eventPublisher,
            AccountTestHelper.FIXED_CLOCK,
        )
    }

    @Test
    fun changePasswordStoresANewHashAndEndsTheOtherSessions() {
        var storedHash: String? = null
        doAnswer { invocation ->
            storedHash = invocation.getArgument(1)
            null
        }.`when`(accountRepository).updatePasswordHash(anyLong(), AccountTestHelper.anyValue())

        service.changePassword(account, "new-password-2", SESSION_TOKEN)

        assertTrue(passwordEncoder.matches("new-password-2", requireNotNull(storedHash)))
        verify(accountRepository).deleteSessionsByAccountIdExcept(7L, SessionTokenHelper.hash(SESSION_TOKEN))
    }

    @Test
    fun changePasswordRejectsAShortNewPasswordAndAMissingSession() {
        assertThrows(IllegalArgumentException::class.java) {
            service.changePassword(account, "short", SESSION_TOKEN)
        }
        assertThrows(AuthenticationRequiredException::class.java) {
            service.changePassword(account, "new-password-2", null)
        }

        verify(accountRepository, never()).updatePasswordHash(anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun previewCountsOpenRecruitmentsAndPendingProposalsOnly() {
        doReturn(2).`when`(recruitmentRepository).countOpenByAccountId(7L)
        doReturn(emptyList<Any>()).`when`(proposalRepository).findReceivedBy(7L)
        doReturn(emptyList<Any>()).`when`(proposalRepository).findSentBy(7L)

        val preview = service.previewDeletion(account)

        assertEquals(false, preview.hasCompany)
        assertEquals(2, preview.openRecruitmentCount)
        assertEquals(0, preview.receivedPendingProposalCount)
        assertEquals(0, preview.sentPendingProposalCount)
    }

    @Test
    fun deleteAccountWithdrawsProposalsClosesRecruitmentsRemovesTheCompanyLinksAndSessionsThenMarksDeleted() {
        stubCredential()

        service.deleteAccount(account, "password1")

        verify(proposalRepository).withdrawAllPendingByProposer(7L, NOW)
        verify(recruitmentRepository).closeAllByAccountId(7L, NOW)
        verify(companyRepository).deleteByAccountId(7L)
        verify(accountRepository).deleteNonKakaoIdentities(7L)
        verify(accountRepository).deleteAllSessionsByAccountId(7L)
        verify(accountRepository).markDeleted(7L, NOW)
        verifyNoInteractions(unlinkRepository)
        verify(eventPublisher).publishEvent(AccountDeletedEvent(7L) as Any)
    }

    @Test
    fun deleteAccountRecordsKakaoWorkBeforeRemovingNonKakaoLinks() {
        stubCredential()
        val links = listOf(OAuthLink(OAuthProvider.KAKAO, "4012345678"))
        doReturn(links).`when`(accountRepository).findOAuthLinks(7L)

        service.deleteAccount(account, "password1")

        val order = inOrder(accountRepository, unlinkRepository)
        order.verify(accountRepository).findOAuthLinks(7L)
        order.verify(unlinkRepository).enqueue(7L, "4012345678")
        order.verify(accountRepository).deleteNonKakaoIdentities(7L)
        order.verify(accountRepository).markDeleted(7L, NOW)
    }

    @Test
    fun deleteAccountRejectsAWrongPasswordWithoutTouchingAnything() {
        stubCredential()
        assertThrows(CurrentPasswordMismatchException::class.java) { service.deleteAccount(account, "wrong-password") }

        verify(companyRepository, never()).deleteByAccountId(anyLong())
        verify(recruitmentRepository, never()).closeAllByAccountId(anyLong(), AccountTestHelper.anyValue())
        verify(accountRepository, never()).markDeleted(anyLong(), AccountTestHelper.anyValue())
    }

    @Test
    fun deleteAccountOfASocialOnlyAccountNeedsNoPassword() {
        // 소셜 로그인으로만 가입한 계정은 확인할 비밀번호가 없어 세션만으로 삭제합니다.
        service.deleteAccount(account.copy(hasPassword = false), null)

        verify(accountRepository, never()).findCredentialByEmail(anyString())
        verify(accountRepository).markDeleted(7L, NOW)
    }

    @Test
    fun deleteAccountRefusesTheOnlyActiveAdminButLetsOneOfSeveralAdminsLeave() {
        val admin = AccountTestHelper.account(id = 7L, role = AccountRole.ADMIN)
        stubCredential()
        doReturn(1).`when`(accountRepository).countActiveAdmins()

        assertThrows(LastAdminDeletionException::class.java) { service.deleteAccount(admin, "password1") }
        verify(accountRepository, never()).markDeleted(anyLong(), AccountTestHelper.anyValue())

        doReturn(2).`when`(accountRepository).countActiveAdmins()
        service.deleteAccount(admin, "password1")
        verify(accountRepository).markDeleted(7L, NOW)
    }

    @Test
    fun deleteAccountWithAPasswordRejectsAMissingPassword() {
        stubCredential()
        assertThrows(CurrentPasswordMismatchException::class.java) { service.deleteAccount(account, null) }

        verify(accountRepository, never()).markDeleted(anyLong(), AccountTestHelper.anyValue())
    }

    private fun stubCredential() {
        doReturn(AccountCredential(account, requireNotNull(passwordEncoder.encode("password1"))))
            .`when`(accountRepository).findCredentialByEmail("manager@company.co.kr")
    }

    private companion object {
        const val SESSION_TOKEN = "header.payload.signature"
    }
}
