package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.mail.AccountPasswordResetMailClient
import ai.govbiz.core.account.config.AccountDevLoginProperties
import ai.govbiz.core.account.config.AccountPasswordResetProperties
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.PasswordResetPass
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.helper.normalizeEmail
import ai.govbiz.core.account.repository.AccountPasswordResetRepository
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.EmailCodeExpiredException
import ai.govbiz.core.account.service.exception.EmailCodeInvalidException
import ai.govbiz.core.account.service.exception.EmailCodeRateLimitedException
import ai.govbiz.core.account.service.exception.PasswordResetAccountNotFoundException
import ai.govbiz.core.account.service.exception.PasswordResetMailUnavailableException
import ai.govbiz.core.account.service.exception.PasswordResetSocialAccountException
import ai.govbiz.core.account.service.exception.PasswordResetTokenInvalidException
import java.security.SecureRandom
import java.time.Clock
import java.time.Duration
import java.time.LocalDateTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/**
 * 비밀번호를 잊은 회원에게 메일로 6자리 인증번호를 보내고, 인증번호를 맞힌 뒤 받은 통행 토큰으로 새 비밀번호를 저장합니다.
 *
 * 가입하지 않은 이메일과 소셜 로그인으로만 가입한 계정은 각각 404·409로 알려 사용자가 회원가입이나 소셜 로그인으로 가게 합니다.
 * 인증번호는 [AccountPasswordResetProperties.codeTtl] 동안 [AccountPasswordResetProperties.maxAttempts]번까지 입력할 수 있고,
 * 통행 토큰은 [AccountPasswordResetProperties.tokenTtl] 동안 한 번만 쓸 수 있으며 성공하면 모든 세션이 끝납니다.
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
    private val random = SecureRandom()

    /**
     * 인증번호를 만들어 메일로 보냅니다. 가입하지 않은 이메일은 404, 소셜로만 가입한 계정은 409,
     * 재전송 대기·시간당 한도를 넘기면 429이고, 정지된 계정은 아무 일도 하지 않고 조용히 끝납니다(정지 여부는 드러내지 않습니다).
     * SMTP가 없으면 개발용 로그인이 켜진 환경에서만 인증번호를 로그로 남기고, 아니면 503입니다.
     */
    fun request(rawEmail: String, clientAddress: String) {
        loginAttemptGuard.checkAddressAllowed(clientAddress)
        val canDeliver = mailClient.isAvailable() || devLoginProperties.enabled
        if (!canDeliver) throw PasswordResetMailUnavailableException()

        val account = findResettableAccount(rawEmail)
        if (account.isSuspended) return

        val now = LocalDateTime.now(clock)
        val lastSentAt = resetRepository.findLatestSentAt(account.id)
        if (lastSentAt != null) {
            val retryAt = lastSentAt.plus(properties.resendCooldown)
            if (retryAt.isAfter(now)) throw EmailCodeRateLimitedException(secondsUntil(now, retryAt))
        }
        if (resetRepository.countRequestsSince(account.id, now.minusHours(1)) >= properties.maxRequestsPerHour) {
            throw EmailCodeRateLimitedException(Duration.ofHours(1).seconds.toInt())
        }

        val code = "%06d".format(random.nextInt(1_000_000))
        // SMTP 실패 시에도 발송 이력은 남겨 메일 폭주를 방지합니다. 외부 호출은 저장 transaction 밖입니다.
        resetRepository.create(account.id, codeHash(account.email, code), now.plus(properties.codeTtl), now)
        if (mailClient.isAvailable()) {
            mailClient.sendPasswordResetCode(account.email, code)
        } else {
            log.warn("[개발] SMTP가 없어 {} 계정의 비밀번호 재설정 인증번호를 로그로 대신 남깁니다: {}", account.email, code)
        }
    }

    /**
     * 인증번호를 확인하고 새 비밀번호 저장에 쓸 통행 토큰을 돌려줍니다. 보낸 인증번호가 없거나 만료됐거나 시도를 다 썼으면
     * 만료 오류, 틀리면 시도 횟수를 올리고 불일치 오류입니다. 가입하지 않은 이메일·소셜 계정은 요청 때와 같은 응답입니다.
     */
    fun verify(rawEmail: String, code: String, clientAddress: String): PasswordResetPass {
        loginAttemptGuard.checkAddressAllowed(clientAddress)
        val account = findResettableAccount(rawEmail)
        if (account.isSuspended) throw EmailCodeExpiredException()

        val now = LocalDateTime.now(clock)
        val reset = resetRepository.findLatestUnverifiedByAccountId(account.id, now) ?: throw EmailCodeExpiredException()
        if (reset.attemptCount >= properties.maxAttempts) throw EmailCodeExpiredException()
        if (reset.codeHash != codeHash(account.email, code)) {
            resetRepository.incrementAttempts(reset.id)
            throw EmailCodeInvalidException()
        }

        val passToken = OneTimeTokenHelper.newToken()
        val passExpiresAt = now.plus(properties.tokenTtl)
        resetRepository.markVerified(reset.id, OneTimeTokenHelper.hash(passToken), now, passExpiresAt)
        return PasswordResetPass(passToken = passToken, expiresAt = passExpiresAt)
    }

    /** 통행 토큰으로 새 비밀번호를 저장하고 남은 인증번호와 모든 세션을 없앱니다. 토큰이 없거나 만료·사용됐으면 422입니다. */
    @Transactional
    fun reset(token: String, newPassword: String) {
        require(newPassword.length in AccountSignupService.PASSWORD_LENGTH) {
            "password must be ${AccountSignupService.PASSWORD_LENGTH} characters"
        }
        if (!OneTimeTokenHelper.PATTERN.matches(token)) throw PasswordResetTokenInvalidException()

        val now = LocalDateTime.now(clock)
        val reset = resetRepository.findVerifiedPass(OneTimeTokenHelper.hash(token), now)
            ?: throw PasswordResetTokenInvalidException()
        val account = accountRepository.findById(reset.accountId) ?: throw PasswordResetTokenInvalidException()
        if (account.isSuspended) throw AccountSuspendedException()
        // 소셜로만 가입한 계정에 비밀번호가 생기지 않도록 저장 직전에도 막습니다.
        if (!account.hasPassword) throw PasswordResetSocialAccountException()

        accountRepository.updatePasswordHash(account.id, requireNotNull(passwordEncoder.encode(newPassword)) { "password hash must not be null" })
        resetRepository.deleteAllByAccountId(account.id)
        accountRepository.deleteAllSessionsByAccountId(account.id)
        loginAttemptGuard.recordSuccess(account.email)
    }

    /** 이메일로 가입한 계정만 재설정할 수 있습니다. 없으면 404, 소셜로만 가입해 비밀번호가 없으면 409입니다. */
    private fun findResettableAccount(rawEmail: String): Account {
        val email = normalizeEmail(rawEmail)
        val account = accountRepository.findByEmail(email) ?: throw PasswordResetAccountNotFoundException()
        if (!account.hasPassword) throw PasswordResetSocialAccountException()
        return account
    }

    private fun codeHash(email: String, code: String): String = OneTimeTokenHelper.hash("$email:$code")

    private fun secondsUntil(now: LocalDateTime, until: LocalDateTime): Int =
        Duration.between(now, until).seconds.toInt().coerceAtLeast(1)
}
