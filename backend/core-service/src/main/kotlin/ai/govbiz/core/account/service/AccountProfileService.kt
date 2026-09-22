package ai.govbiz.core.account.service

import ai.govbiz.core.account.helper.PasswordValidationHelper

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.repository.AccountOAuthUnlinkRepository
import ai.govbiz.core.account.service.dto.AccountDeletedEvent
import ai.govbiz.core.account.service.dto.AccountDeletionPreview
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.service.exception.CurrentPasswordMismatchException
import ai.govbiz.core.account.service.exception.LastAdminDeletionException
import ai.govbiz.core.partner.domain.PartnerProposalStatus
import ai.govbiz.core.partner.repository.PartnerProposalRepository
import ai.govbiz.core.partner.repository.PartnerRecruitmentRepository
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.context.ApplicationEventPublisher
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/**
 * 로그인한 회원이 자기 계정을 관리합니다. 비밀번호 변경과 계정 삭제는 현재 비밀번호를 다시 확인합니다.
 * 삭제는 계정·기업·모집글·제안 정리와 연결 해제 작업 저장을 한 transaction으로 묶으며 경계는 이 Service가 소유합니다.
 */
@Service
class AccountProfileService(
    private val accountRepository: AccountRepository,
    private val companyRepository: CompanyRepository,
    private val recruitmentRepository: PartnerRecruitmentRepository,
    private val proposalRepository: PartnerProposalRepository,
    private val passwordEncoder: PasswordEncoder,
    private val unlinkRepository: AccountOAuthUnlinkRepository,
    private val eventPublisher: ApplicationEventPublisher,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /** 새 비밀번호를 저장하고 지금 쓰는 세션만 남긴 채 다른 기기의 세션을 끝냅니다. 본인 확인은 세션이 맡고 현재 비밀번호는 다시 묻지 않습니다. */
    fun changePassword(account: Account, newPassword: String, sessionToken: String?) {
        PasswordValidationHelper.requireNewPassword(newPassword)
        val token = sessionToken?.trim()?.takeIf(String::isNotEmpty) ?: throw AuthenticationRequiredException()

        accountRepository.updatePasswordHash(account.id, requireNotNull(passwordEncoder.encode(newPassword)))
        accountRepository.deleteSessionsByAccountIdExcept(account.id, SessionTokenHelper.hash(token))
    }

    /** 삭제 확인 화면에 보여 줄, 삭제와 함께 닫히거나 철회되는 것들의 수입니다. */
    fun previewDeletion(account: Account): AccountDeletionPreview {
        val now = LocalDateTime.now(clock)
        return AccountDeletionPreview(
            hasCompany = account.hasCompany,
            openRecruitmentCount = recruitmentRepository.countOpenByAccountId(account.id),
            receivedPendingProposalCount = proposalRepository.findReceivedBy(account.id).count { it.status(now) == PartnerProposalStatus.PENDING },
            sentPendingProposalCount = proposalRepository.findSentBy(account.id).count { it.status(now) == PartnerProposalStatus.PENDING },
        )
    }

    /**
     * 탈퇴와 카카오 연결 해제 작업을 함께 저장한다. 카카오 identity는 성공 전까지 재가입 방지용으로 유지한다.
     * 외부 연결 해제는 커밋 후 별도 워커가 수행하며, 회원·기업·세션 삭제 transaction에서 HTTP를 호출하지 않는다.
     */
    @Transactional
    fun deleteAccount(account: Account, currentPassword: String?) {
        // 소셜 로그인으로만 가입해 비밀번호가 없는 계정은 확인할 비밀번호가 없어 세션만으로 본인을 확인합니다.
        if (account.hasPassword) verifyCurrentPassword(account, currentPassword.orEmpty())
        // 마지막 관리자가 탈퇴하면 관리자 화면을 열 계정이 없어지므로 막습니다.
        if (account.isAdmin && accountRepository.countActiveAdmins() <= 1) throw LastAdminDeletionException()
        val now = LocalDateTime.now(clock)
        val oauthLinks = accountRepository.findOAuthLinks(account.id)

        proposalRepository.withdrawAllPendingByProposer(account.id, now)
        recruitmentRepository.closeAllByAccountId(account.id, now)
        companyRepository.deleteByAccountId(account.id)
        oauthLinks.filter { it.provider == OAuthProvider.KAKAO }.forEach { unlinkRepository.enqueue(account.id, it.subject) }
        accountRepository.deleteNonKakaoIdentities(account.id)
        accountRepository.deleteAllSessionsByAccountId(account.id)
        accountRepository.markDeleted(account.id, now)
        // 대화 기록 등 로컬 정리는 기존 동기 이벤트로 같은 transaction 안에서 처리한다.
        eventPublisher.publishEvent(AccountDeletedEvent(account.id))
    }

    /** 세션을 확인한 뒤 비밀번호가 지워졌다면 해시가 없어 불일치로 봅니다. */
    private fun verifyCurrentPassword(account: Account, currentPassword: String) {
        val credential = accountRepository.findCredentialByEmail(account.email) ?: throw CurrentPasswordMismatchException()
        if (!passwordEncoder.matches(currentPassword, credential.passwordHash)) throw CurrentPasswordMismatchException()
    }
}
