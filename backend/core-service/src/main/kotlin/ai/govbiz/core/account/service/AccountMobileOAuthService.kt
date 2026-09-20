package ai.govbiz.core.account.service

import ai.govbiz.core.account.config.AccountMobileOAuthProperties
import ai.govbiz.core.account.domain.MobileOAuthTransaction
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.helper.OAuthStateCookieHelper
import ai.govbiz.core.account.helper.OneTimeTokenHelper
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.MobileOAuthTransactionRepository
import ai.govbiz.core.account.service.dto.AccountSessionResult
import ai.govbiz.core.account.service.dto.OAuthAccountCompletionResult
import ai.govbiz.core.account.service.dto.OAuthCallback
import ai.govbiz.core.account.service.dto.OAuthStartResult
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.MobileOAuthExchangeInvalidException
import ai.govbiz.core.account.service.exception.MobileOAuthRequestInvalidException
import java.net.URI
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.util.Base64
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/** 공급자 웹 로그인을 앱의 PKCE 일회용 코드로 연결합니다. 외부 호출 중에는 DB transaction을 열지 않습니다. */
@Service
class AccountMobileOAuthService(
    private val oauthService: AccountOAuthService,
    private val transactions: MobileOAuthTransactionRepository,
    private val accounts: AccountRepository,
    private val sessions: AccountSessionService,
    private val properties: AccountMobileOAuthProperties,
    private val attemptGuard: AccountLoginAttemptGuard,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun start(provider: String, redirectUri: String, state: String, challenge: String,
              rememberMe: Boolean, clientAddress: String): OAuthStartResult? {
        if (redirectUri !in properties.redirectUris || !APP_STATE.matches(state) || !CHALLENGE.matches(challenge)) {
            throw MobileOAuthRequestInvalidException()
        }
        attemptGuard.checkAddressAllowed(clientAddress)
        val known = OAuthProvider.fromPathName(provider) ?: return null
        val started = oauthService.start(known, null, rememberMe) ?: return null
        val transaction = started.transaction.copy(mobile = true)
        transactions.create(MobileOAuthTransaction(
            SessionTokenHelper.hash(transaction.state), known, redirectUri, state, challenge, rememberMe,
            LocalDateTime.ofInstant(transaction.expiresAt, clock.zone),
        ))
        return started.copy(transaction = transaction)
    }

    fun complete(provider: OAuthProvider?, callback: OAuthCallback, transaction: OAuthStateCookieHelper.Transaction,
                 clientAddress: String): URI {
        if (!transaction.mobile || provider == null || provider != transaction.provider || callback.state != transaction.state ||
            !transaction.expiresAt.isAfter(Instant.now(clock))) throw MobileOAuthExchangeInvalidException()
        val pending = transactions.claimCallback(SessionTokenHelper.hash(transaction.state), provider, LocalDateTime.now(clock))
            ?: throw MobileOAuthExchangeInvalidException()
        if (pending.redirectUri !in properties.redirectUris) throw MobileOAuthExchangeInvalidException()
        return when (val result = oauthService.authenticate(provider, callback, transaction, clientAddress)) {
            is OAuthAccountCompletionResult.Failed -> callbackUri(pending.redirectUri, pending.appState, error = result.failure.code)
            is OAuthAccountCompletionResult.SignedIn -> {
                val code = OneTimeTokenHelper.newToken()
                transactions.issueCode(pending.stateHash, SessionTokenHelper.hash(code), result.account.id, LocalDateTime.now(clock).plusSeconds(60))
                callbackUri(pending.redirectUri, pending.appState, code = code)
            }
        }
    }

    /** 코드 소비와 세션 저장을 한 transaction으로 묶고, 계정 폐기·정지 여부도 교환 시 다시 확인합니다. */
    @Transactional
    fun exchange(code: String, verifier: String, redirectUri: String, clientAddress: String): AccountSessionResult {
        if (redirectUri !in properties.redirectUris || !CHALLENGE.matches(code) || !VERIFIER.matches(verifier)) {
            throw MobileOAuthExchangeInvalidException()
        }
        attemptGuard.checkAddressAllowed(clientAddress)
        val challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)),
        )
        val pending = transactions.consumeCode(SessionTokenHelper.hash(code), redirectUri, challenge, LocalDateTime.now(clock))
            ?: throw MobileOAuthExchangeInvalidException()
        val account = pending.accountId?.let(accounts::findById) ?: throw MobileOAuthExchangeInvalidException()
        if (account.isSuspended) throw AccountSuspendedException()
        val issued = sessions.issue(account.id, pending.rememberMe)
        accounts.createSession(account.id, issued.session)
        return sessions.toResult(issued, account)
    }

    companion object {
        private val APP_STATE = Regex("[A-Za-z0-9_-]{43,128}")
        private val CHALLENGE = Regex("[A-Za-z0-9_-]{43}")
        private val VERIFIER = Regex("[A-Za-z0-9._~-]{43,128}")

        /** URI는 allowlist에서, 나머지 값은 URL-safe state·코드 또는 고정 오류 코드에서만 옵니다. */
        fun callbackUri(redirectUri: String, state: String, code: String? = null, error: String? = null): URI =
            URI("$redirectUri?state=$state&${if (code != null) "code=$code" else "error=$error"}")
    }
}
