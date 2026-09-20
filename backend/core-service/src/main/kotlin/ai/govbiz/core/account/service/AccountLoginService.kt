package ai.govbiz.core.account.service

import ai.govbiz.core.account.helper.normalizeEmail
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.dto.AccountSessionResult
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.InvalidCredentialsException
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service

/**
 * 이메일·비밀번호로 로그인하고 새 세션 JWT를 발급합니다. 계정 없음과 비밀번호 불일치는 같은 오류로 답하며,
 * 시도 횟수는 [AccountLoginAttemptGuard]가 계정·접속 주소 기준으로 제한합니다.
 */
@Service
class AccountLoginService(
    private val repository: AccountRepository,
    private val sessionService: AccountSessionService,
    private val passwordEncoder: PasswordEncoder,
    private val attemptGuard: AccountLoginAttemptGuard,
) {

    /** 계정이 없을 때도 비밀번호 비교를 한 번 수행해 응답 시간으로 가입 여부가 드러나지 않게 합니다. */
    private val absentAccountHash: String = requireNotNull(passwordEncoder.encode(ABSENT_ACCOUNT_PASSWORD))

    fun logIn(email: String, password: String, clientAddress: String, rememberMe: Boolean): AccountSessionResult {
        val normalizedEmail = normalizeEmail(email)
        attemptGuard.checkAllowed(normalizedEmail, clientAddress)

        val credential = repository.findCredentialByEmail(normalizedEmail)
        if (credential == null) {
            passwordEncoder.matches(password, absentAccountHash)
            attemptGuard.recordFailure(normalizedEmail)
            throw InvalidCredentialsException()
        }
        if (!passwordEncoder.matches(password, credential.passwordHash)) {
            attemptGuard.recordFailure(normalizedEmail)
            throw InvalidCredentialsException()
        }
        attemptGuard.recordSuccess(normalizedEmail)
        // 정지 여부는 비밀번호가 맞은 뒤에만 알려 줘 계정 존재 여부가 새지 않게 합니다.
        if (credential.account.isSuspended) throw AccountSuspendedException()

        val issued = sessionService.issue(credential.account.id, rememberMe)
        repository.createSession(credential.account.id, issued.session)
        return sessionService.toResult(issued, credential.account)
    }

    private companion object {
        const val ABSENT_ACCOUNT_PASSWORD = "absent-account-timing-guard"
    }
}
