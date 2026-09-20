package ai.govbiz.core.account.service

import ai.govbiz.core.account.config.AccountDevLoginProperties
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.normalizeEmail
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.dto.AccountSessionResult
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.dao.DuplicateKeyException
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service

/**
 * 개발 환경에서 비밀번호 입력 없이 시드 계정으로 로그인합니다.
 *
 * 역할별로 설정한 이메일의 계정이 없으면 이메일 인증까지 끝난 상태로 만들고, 있으면 그대로 씁니다. 만든 계정은
 * 설정한 비밀번호로 일반 로그인도 됩니다. 공개 endpoint는 `app.account.dev-login.enabled`가 켜졌을 때만 등록됩니다.
 */
@Service
class AccountDevLoginService(
    private val repository: AccountRepository,
    private val sessionService: AccountSessionService,
    private val passwordEncoder: PasswordEncoder,
    private val properties: AccountDevLoginProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /** ADMIN이면 관리자(T3), USER면 기업 정보가 없는 회원(T1) 시드 계정으로 세션을 발급합니다. */
    fun logInAs(role: AccountRole): AccountSessionResult {
        val email = normalizeEmail(if (role == AccountRole.ADMIN) properties.email else properties.memberEmail)
        val account = repository.findByEmail(email) ?: createSeedAccount(email, role)

        val issued = sessionService.issue(account.id, rememberMe = true)
        repository.createSession(account.id, issued.session)
        return sessionService.toResult(issued, account)
    }

    private fun createSeedAccount(email: String, role: AccountRole): Account =
        try {
            val now = LocalDateTime.now(clock)
            repository.createAccount(
                NewAccount(
                    email = email,
                    passwordHash = requireNotNull(passwordEncoder.encode(properties.password)) { "password hash must not be null" },
                    termsAgreedAt = now,
                    role = role,
                    emailVerifiedAt = now,
                ),
            )
        } catch (_: DuplicateKeyException) {
            // 같은 순간 다른 요청이 먼저 만들었으면 그 계정을 씁니다.
            requireNotNull(repository.findByEmail(email)) { "dev seed account was not readable" }
        }
}
