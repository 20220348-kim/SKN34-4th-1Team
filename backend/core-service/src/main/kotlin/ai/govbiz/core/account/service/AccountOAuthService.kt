package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.oauth.GoogleOAuthClient
import ai.govbiz.core.account.client.oauth.KakaoOAuthClient
import ai.govbiz.core.account.client.oauth.OAuthProviderClient
import ai.govbiz.core.account.client.oauth.exception.OAuthClientException
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.domain.OAuthProfile
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.helper.OAuthStateCookieHelper
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.helper.normalizeEmail
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.dto.OAuthCallback
import ai.govbiz.core.account.service.dto.OAuthAccountCompletionResult
import ai.govbiz.core.account.service.dto.OAuthCompletionResult
import ai.govbiz.core.account.service.dto.OAuthFailure
import ai.govbiz.core.account.service.dto.OAuthStartResult
import ai.govbiz.core.account.service.exception.LoginRateLimitedException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service

/**
 * 카카오·Google 계정으로 가입하고 로그인합니다(OAuth 2.0 인가 코드 흐름 + OpenID Connect).
 *
 * 계정은 공급자 계정의 `sub`로만 찾습니다. 처음 온 공급자 계정은 공급자가 인증한 이메일로 새 회원(비밀번호 없음·이메일
 * 인증 완료)을 만듭니다. 그 이메일로 이미 가입한 계정이 있으면 자동으로 연결하지 않고 [OAuthFailure.ACCOUNT_EXISTS]로
 * 돌려보냅니다. 남의 이메일로 미인증 계정을 먼저 만들어 두고 피해자의 소셜 로그인이 붙기를 기다리는 사전 탈취
 * (pre-account hijacking)를 막기 위해서입니다. 공급자 호출은 DB transaction 밖에서 끝내고, 계정과 연결 저장만
 * Repository의 transaction으로 묶습니다.
 */
@Service
class AccountOAuthService(
    googleClient: GoogleOAuthClient,
    kakaoClient: KakaoOAuthClient,
    private val repository: AccountRepository,
    private val sessionService: AccountSessionService,
    private val attemptGuard: AccountLoginAttemptGuard,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    private val log = LoggerFactory.getLogger(javaClass)

    /** 로그인 화면의 버튼 순서입니다. */
    private val clients: List<OAuthProviderClient> = listOf(kakaoClient, googleClient)

    /** 클라이언트 ID·시크릿이 설정된 공급자들입니다. */
    fun availableProviders(): List<OAuthProvider> =
        clients.filter(OAuthProviderClient::isConfigured).map(OAuthProviderClient::provider)

    /** 공급자 로그인 화면 주소와 콜백에서 확인할 값을 만듭니다. 꺼진 공급자면 null입니다. */
    fun start(provider: OAuthProvider, returnPath: String?, rememberMe: Boolean): OAuthStartResult? {
        val client = configuredClient(provider) ?: return null
        val transaction = OAuthStateCookieHelper.Transaction(
            provider = provider,
            state = OneTimeTokenHelper.newToken(),
            nonce = OneTimeTokenHelper.newToken(),
            codeVerifier = OneTimeTokenHelper.newToken(),
            returnPath = safeReturnPath(returnPath),
            rememberMe = rememberMe,
            expiresAt = Instant.now(clock).plus(OAuthStateCookieHelper.TTL),
        )
        return OAuthStartResult(
            authorizationUri = client.authorizationUri(transaction.state, transaction.nonce, transaction.codeVerifier),
            transaction = transaction,
        )
    }

    /**
     * 공급자 콜백을 처리합니다. state가 로그인을 시작한 브라우저의 쿠키와 같을 때만 코드를 교환하고,
     * 계정을 찾거나 만든 뒤 세션을 발급합니다. 실패는 예외 대신 [OAuthCompletionResult.Failed]로 돌려 화면 안내로 이어집니다.
     */
    fun complete(
        provider: OAuthProvider?,
        callback: OAuthCallback,
        transaction: OAuthStateCookieHelper.Transaction?,
        clientAddress: String,
    ): OAuthCompletionResult {
        return when (val result = authenticate(provider, callback, transaction, clientAddress)) {
            is OAuthAccountCompletionResult.Failed -> OAuthCompletionResult.Failed(result.failure, result.returnPath)
            is OAuthAccountCompletionResult.SignedIn -> {
                val issued = sessionService.issue(result.account.id, requireNotNull(transaction).rememberMe)
                repository.createSession(result.account.id, issued.session)
                OAuthCompletionResult.SignedIn(sessionService.toResult(issued, result.account), result.returnPath)
            }
        }
    }

    /** 공급자 HTTP 호출은 DB transaction 밖에서 실행합니다. 웹·앱이 같은 계정 확인 정책을 사용합니다. */
    fun authenticate(
        provider: OAuthProvider?,
        callback: OAuthCallback,
        transaction: OAuthStateCookieHelper.Transaction?,
        clientAddress: String,
    ): OAuthAccountCompletionResult {
        val returnPath = transaction?.returnPath ?: DEFAULT_RETURN_PATH
        fun failed(failure: OAuthFailure) = OAuthAccountCompletionResult.Failed(failure, returnPath)

        val client = provider?.let(::configuredClient) ?: return failed(OAuthFailure.UNAVAILABLE)
        // state가 쿠키와 같아야 이 브라우저가 시작한 로그인입니다. 다르면 CSRF이거나 쿠키가 만료된 것입니다.
        if (transaction == null || transaction.provider != provider || !sameValue(transaction.state, callback.state)) {
            return failed(OAuthFailure.EXPIRED)
        }
        val error = callback.error
        if (error != null) return failed(if (error == ACCESS_DENIED) OAuthFailure.CANCELLED else OAuthFailure.FAILED)
        val code = callback.code?.takeIf(String::isNotBlank) ?: return failed(OAuthFailure.FAILED)
        try {
            attemptGuard.checkAddressAllowed(clientAddress)
        } catch (_: LoginRateLimitedException) {
            return failed(OAuthFailure.RATE_LIMITED)
        }

        val profile = try {
            client.exchange(code, transaction.codeVerifier, transaction.nonce)
        } catch (exception: OAuthClientException) {
            log.warn("{} 소셜 로그인 코드 교환에 실패했습니다: {}", provider, exception.failure)
            return failed(OAuthFailure.FAILED)
        }

        val account = when (val resolution = findOrCreateAccount(profile)) {
            is Resolution.Found -> resolution.account
            is Resolution.Rejected -> return failed(resolution.failure)
        }
        if (account.isSuspended) return failed(OAuthFailure.SUSPENDED)

        return OAuthAccountCompletionResult.SignedIn(account, returnPath)
    }

    private fun findOrCreateAccount(profile: OAuthProfile): Resolution {
        repository.findByOAuthIdentity(profile.provider, profile.subject)?.let { account -> return Resolution.Found(account) }
        if (repository.hasPendingOAuthUnlink(profile.provider, profile.subject)) return Resolution.Rejected(OAuthFailure.UNLINK_PENDING)

        val email = profile.verifiedEmail?.let(::normalizeEmail)?.takeIf(::isStorableEmail)
            ?: return Resolution.Rejected(OAuthFailure.EMAIL_REQUIRED)
        if (repository.findByEmail(email) != null) return Resolution.Rejected(OAuthFailure.ACCOUNT_EXISTS)

        val now = LocalDateTime.now(clock)
        return try {
            Resolution.Found(
                repository.createAccountWithOAuthIdentity(
                    // 약관 동의는 가입 화면 안내로 갈음하고 가입 시각을 기록합니다. 이메일은 공급자가 인증했습니다.
                    NewAccount(email = email, passwordHash = null, termsAgreedAt = now, emailVerifiedAt = now),
                    profile.provider,
                    profile.subject,
                ),
            )
        } catch (_: DuplicateKeyException) {
            // 같은 공급자 계정의 동시 콜백이면 먼저 만든 계정을 쓰고, 같은 이메일의 동시 가입이면 연결하지 않습니다.
            repository.findByOAuthIdentity(profile.provider, profile.subject)?.let(Resolution::Found)
                ?: Resolution.Rejected(
                    if (repository.hasPendingOAuthUnlink(profile.provider, profile.subject)) OAuthFailure.UNLINK_PENDING
                    else OAuthFailure.ACCOUNT_EXISTS,
                )
        }
    }

    private fun configuredClient(provider: OAuthProvider): OAuthProviderClient? =
        clients.firstOrNull { client -> client.provider == provider && client.isConfigured() }

    private sealed interface Resolution {
        data class Found(val account: Account) : Resolution
        data class Rejected(val failure: OAuthFailure) : Resolution
    }

    companion object {
        const val DEFAULT_RETURN_PATH = "/app/chat"
        private const val ACCESS_DENIED = "access_denied"
        private const val MAX_RETURN_PATH_LENGTH = 512
        private const val MAX_EMAIL_LENGTH = 320
        private val OTHER_CHARACTER_TYPES = setOf(
            Character.CONTROL.toInt(),
            Character.FORMAT.toInt(),
            Character.PRIVATE_USE.toInt(),
            Character.SURROGATE.toInt(),
            Character.UNASSIGNED.toInt(),
        )

        /**
         * 프런트 `readReturnPath`와 같은 규칙으로 앱 안의 절대 경로만 받습니다. `//evil.example`이나 역슬래시·제어 문자로
         * 외부 주소로 새는 open redirect를 막고, 규칙에 맞지 않으면 작업 채팅으로 돌아갑니다.
         */
        fun safeReturnPath(value: String?): String {
            val path = value?.trim().orEmpty()
            val valid = path.startsWith('/') && !path.startsWith("//") && '\\' !in path &&
                path.length <= MAX_RETURN_PATH_LENGTH && path.none { char -> Character.getType(char) in OTHER_CHARACTER_TYPES }
            return if (valid) path else DEFAULT_RETURN_PATH
        }

        private fun isStorableEmail(email: String): Boolean =
            email.length <= MAX_EMAIL_LENGTH && '@' in email && email.none(Char::isWhitespace)

        private fun sameValue(expected: String, actual: String?): Boolean =
            actual != null && MessageDigest.isEqual(
                expected.toByteArray(StandardCharsets.UTF_8),
                actual.toByteArray(StandardCharsets.UTF_8),
            )
    }
}
