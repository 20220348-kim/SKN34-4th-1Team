package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.mail.AccountPasswordResetMailClient
import ai.govbiz.core.account.config.AccountDevLoginProperties
import ai.govbiz.core.account.config.AccountPasswordResetProperties
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.helper.normalizeEmail
import ai.govbiz.core.account.repository.AccountPasswordResetRepository
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.PasswordResetMailUnavailableException
import ai.govbiz.core.account.service.exception.PasswordResetTokenInvalidException
import java.time.Clock
import java.time.LocalDateTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/**
 * 비밀번호를 잊은 회원에게 메일로 일회용 재설정 링크를 보내고, 그 토큰으로 새 비밀번호를 저장합니다.
 *
 * 요청은 이메일이 가입돼 있든 없든 같은 응답이라 가입 여부가 드러나지 않고, 계정당 시간당 요청 수를 제한합니다.
 * 토큰은 [AccountPasswordResetProperties.tokenTtl] 동안 한 번만 쓸 수 있으며 성공하면 모든 세션이 끝납니다.
 */
@Service
class AccountPasswordResetService(
    private val accountRepository: AccountRepository,
    private val resetRepository: AccountPasswordResetRepository,
    private val mailClient: AccountPasswordResetMailClient,
    private val loginAttemptGuard: AccountLoginAttemptGuard,
    private val passwordEncoder: PasswordEncoder,
    private val properties: AccountPasswordResetProperties,
    private val devLoginProperties: AccountDevLoginProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    private val log = LoggerFactory.getLogger(javaClass)

    /**
     * 재설정 링크를 요청합니다. 계정이 없거나 정지됐거나 시간당 한도를 넘으면 아무 일도 하지 않고 조용히 끝납니다.
     * SMTP가 없으면 개발용 로그인이 켜진 환경에서만 링크를 로그로 남기고, 아니면 503입니다.
     */
    fun request(rawEmail: String, clientAddress: String) {
        loginAttemptGuard.checkAddressAllowed(clientAddress)
        val canDeliver = mailClient.isAvailable() || devLoginProperties.enabled
        if (!canDeliver) throw PasswordResetMailUnavailableException()

        val email = normalizeEmail(rawEmail)
        val account = accountRepository.findByEmail(email) ?: return
        if (account.isSuspended) return

        val now = LocalDateTime.now(clock)
        if (resetRepository.countRequestsSince(account.id, now.minusHours(1)) >= properties.maxRequestsPerHour) return

        val token = OneTimeTokenHelper.newToken()
        // SMTP 실패 시에도 요청 이력은 남겨 메일 폭주를 방지합니다. 외부 호출은 저장 transaction 밖입니다.
        resetRepository.create(account.id, OneTimeTokenHelper.hash(token), now.plus(properties.tokenTtl), now)
        if (mailClient.isAvailable()) {
            mailClient.sendPasswordReset(account.email, token)
        } else {
            log.warn("[개발] SMTP가 없어 {} 계정의 비밀번호 재설정 링크를 로그로 대신 남깁니다: {}", account.email, mailClient.resetLink(token))
        }
    }

    /** 토큰으로 새 비밀번호를 저장하고 남은 토큰과 모든 세션을 없앱니다. 토큰이 없거나 만료·사용됐으면 422입니다. */
    @Transactional
    fun reset(token: String, newPassword: String) {
        require(newPassword.length in AccountSignupService.PASSWORD_LENGTH) {
            "password must be ${AccountSignupService.PASSWORD_LENGTH} characters"
        }
        if (!OneTimeTokenHelper.PATTERN.matches(token)) throw PasswordResetTokenInvalidException()

        val now = LocalDateTime.now(clock)
        val reset = resetRepository.findActiveByTokenHash(OneTimeTokenHelper.hash(token), now)
            ?: throw PasswordResetTokenInvalidException()
        val account = accountRepository.findById(reset.accountId) ?: throw PasswordResetTokenInvalidException()
        if (account.isSuspended) throw AccountSuspendedException()

        accountRepository.updatePasswordHash(account.id, requireNotNull(passwordEncoder.encode(newPassword)) { "password hash must not be null" })
        resetRepository.deleteAllByAccountId(account.id)
        accountRepository.deleteAllSessionsByAccountId(account.id)
        loginAttemptGuard.recordSuccess(account.email)
    }
}
