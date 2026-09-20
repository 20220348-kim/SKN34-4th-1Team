package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.mail.AccountEmailVerificationMailClient
import ai.govbiz.core.account.config.AccountDevLoginProperties
import ai.govbiz.core.account.config.AccountEmailVerificationProperties
import ai.govbiz.core.account.domain.SignupEmailPass
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.helper.normalizeEmail
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.SignupEmailVerificationRepository
import ai.govbiz.core.account.service.exception.EmailAlreadyRegisteredException
import ai.govbiz.core.account.service.exception.EmailCodeExpiredException
import ai.govbiz.core.account.service.exception.EmailCodeInvalidException
import ai.govbiz.core.account.service.exception.EmailCodeRateLimitedException
import ai.govbiz.core.account.service.exception.EmailVerificationMailUnavailableException
import java.security.SecureRandom
import java.time.Clock
import java.time.Duration
import java.time.LocalDateTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/**
 * 회원가입 전에 이메일이 본인 주소인지 인증번호로 확인합니다.
 *
 * 인증번호는 6자리 숫자이며 [AccountEmailVerificationProperties.codeTtl] 동안 [AccountEmailVerificationProperties.maxAttempts]번까지
 * 입력할 수 있습니다. 맞히면 가입 요청에 실어 보낼 통행 토큰을 돌려주고, 가입이 그 토큰을 한 번 쓰면 끝납니다.
 * 계정이 아직 없으므로 모든 기록은 이메일 기준이고 세션이 필요 없습니다.
 */
@Service
class AccountSignupEmailVerificationService(
    private val accountRepository: AccountRepository,
    private val verificationRepository: SignupEmailVerificationRepository,
    private val mailClient: AccountEmailVerificationMailClient,
    private val loginAttemptGuard: AccountLoginAttemptGuard,
    private val properties: AccountEmailVerificationProperties,
    private val devLoginProperties: AccountDevLoginProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    private val log = LoggerFactory.getLogger(javaClass)
    private val random = SecureRandom()

    /**
     * 인증번호를 만들어 메일로 보냅니다. 이미 가입된 이메일은 409, 재전송 대기·발송 한도를 넘기면 429입니다.
     * SMTP가 없으면 개발용 로그인이 켜진 환경에서만 인증번호를 로그로 남기고, 아니면 503입니다.
     */
    fun sendCode(rawEmail: String, clientAddress: String) {
        loginAttemptGuard.checkAddressAllowed(clientAddress)
        val canDeliver = mailClient.isAvailable() || devLoginProperties.enabled
        if (!canDeliver) throw EmailVerificationMailUnavailableException()

        val email = normalizeEmail(rawEmail)
        if (accountRepository.findByEmail(email) != null) throw EmailAlreadyRegisteredException()

        val now = LocalDateTime.now(clock)
        val lastSentAt = verificationRepository.findLatestSentAt(email)
        if (lastSentAt != null) {
            val retryAt = lastSentAt.plus(properties.resendCooldown)
            if (retryAt.isAfter(now)) throw EmailCodeRateLimitedException(secondsUntil(now, retryAt))
        }
        if (verificationRepository.countSendsSince(email, now.minus(properties.sendWindow)) >= properties.maxSendsPerWindow) {
            throw EmailCodeRateLimitedException(properties.sendWindow.seconds.toInt())
        }

        val code = "%06d".format(random.nextInt(1_000_000))
        // SMTP 실패 시에도 발송 이력은 남겨 메일 폭주를 방지합니다. 외부 호출은 저장 transaction 밖입니다.
        verificationRepository.create(email, codeHash(email, code), now.plus(properties.codeTtl), now)
        if (mailClient.isAvailable()) {
            mailClient.sendSignupCode(email, code)
        } else {
            log.warn("[개발] SMTP가 없어 {} 가입 인증번호를 로그로 대신 남깁니다: {}", email, code)
        }
    }

    /**
     * 인증번호를 확인하고 가입 통행 토큰을 돌려줍니다. 보낸 인증번호가 없거나 만료됐거나 시도를 다 썼으면 만료 오류,
     * 틀리면 시도 횟수를 올리고 불일치 오류입니다.
     */
    fun verifyCode(rawEmail: String, code: String, clientAddress: String): SignupEmailPass {
        loginAttemptGuard.checkAddressAllowed(clientAddress)
        val email = normalizeEmail(rawEmail)
        val now = LocalDateTime.now(clock)
        val verification = verificationRepository.findLatestUnverifiedByEmail(email, now) ?: throw EmailCodeExpiredException()
        if (verification.attemptCount >= properties.maxAttempts) throw EmailCodeExpiredException()
        if (verification.codeHash != codeHash(email, code)) {
            verificationRepository.incrementAttempts(verification.id)
            throw EmailCodeInvalidException()
        }

        val passToken = OneTimeTokenHelper.newToken()
        val passExpiresAt = now.plus(properties.passTtl)
        verificationRepository.markVerified(verification.id, OneTimeTokenHelper.hash(passToken), now, passExpiresAt)
        return SignupEmailPass(passToken = passToken, expiresAt = passExpiresAt)
    }

    /** 가입 요청의 통행 토큰이 그 이메일로 인증을 마친 아직 쓰지 않은 토큰이면 행 id, 아니면 null입니다. */
    fun findVerifiedPassId(email: String, passToken: String, now: LocalDateTime): Long? {
        if (!OneTimeTokenHelper.PATTERN.matches(passToken)) return null
        return verificationRepository.findVerifiedPassId(email, OneTimeTokenHelper.hash(passToken), now)
    }

    /** 가입이 끝난 통행 토큰을 다시 쓸 수 없게 표시합니다. */
    fun consumePass(id: Long, now: LocalDateTime) {
        verificationRepository.markConsumed(id, now)
    }

    private fun codeHash(email: String, code: String): String = OneTimeTokenHelper.hash("$email:$code")

    private fun secondsUntil(now: LocalDateTime, until: LocalDateTime): Int =
        Duration.between(now, until).seconds.toInt().coerceAtLeast(1)
}
