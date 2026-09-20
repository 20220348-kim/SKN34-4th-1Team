package ai.govbiz.core.account.service

import ai.govbiz.core.account.config.AccountSessionProperties
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.NewAccountSession
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.dto.AccountSessionResult
import ai.govbiz.core.account.service.dto.IssuedSessionResult
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/** 세션 JWT를 발급하고, 세션 쿠키의 토큰으로 로그인한 계정을 확인하거나 로그아웃합니다. */
@Service
class AccountSessionService(
    private val repository: AccountRepository,
    private val properties: AccountSessionProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /**
     * 계정 ID로 서명한 JWT와 저장용 해시·만료 시각을 만듭니다. 저장은 호출한 Service가 담당합니다.
     * "로그인 상태 유지"를 켜면 긴 절대 만료, 끄면 짧은 절대 만료를 씁니다.
     */
    fun issue(accountId: Long, rememberMe: Boolean): IssuedSessionResult {
        // JWT의 exp는 초 단위이므로 DB DATETIME(6)와 응답 문자열도 같은 초 값을 가리키게 맞춥니다.
        val issuedAt = Instant.now(clock).truncatedTo(ChronoUnit.SECONDS)
        val ttl = if (rememberMe) properties.sessionTtl else properties.sessionShortTtl
        val expiresAt = issuedAt.plus(ttl)
        val token = SessionTokenHelper.issue(accountId, issuedAt, expiresAt, properties.jwtSecret)
        return IssuedSessionResult(
            sessionToken = token,
            rememberMe = rememberMe,
            session = NewAccountSession(
                tokenHash = SessionTokenHelper.hash(token),
                expiresAt = LocalDateTime.ofInstant(expiresAt, clock.zone),
            ),
        )
    }

    fun toResult(issued: IssuedSessionResult, account: Account): AccountSessionResult =
        AccountSessionResult(
            sessionToken = issued.sessionToken,
            expiresAt = issued.session.expiresAt.atZone(clock.zone).toOffsetDateTime(),
            rememberMe = issued.rememberMe,
            account = account,
        )

    /**
     * 세션 쿠키의 JWT 서명·만료를 먼저 검사하고, 저장된 세션이 절대·유휴 만료 전이면 계정을 돌려줍니다.
     * 토큰이 없거나 서명이 틀리거나 만료됐으면 DB를 보지 않고 401입니다. 정지된 계정은 403입니다.
     * 마지막 사용 시각은 잦은 UPDATE를 피하려고 [TOUCH_INTERVAL]이 지났을 때만 갱신합니다.
     */
    fun requireAccount(sessionToken: String?): Account {
        val token = sessionToken?.trim()?.takeIf(String::isNotEmpty) ?: throw AuthenticationRequiredException()
        val claims = SessionTokenHelper.verify(token, properties.jwtSecret, Instant.now(clock))
            ?: throw AuthenticationRequiredException()

        val tokenHash = SessionTokenHelper.hash(token)
        val now = LocalDateTime.now(clock)
        val session = repository.findSessionByTokenHash(tokenHash) ?: throw AuthenticationRequiredException()
        if (session.accountId != claims.accountId) throw AuthenticationRequiredException()
        if (!session.expiresAt.isAfter(now)) throw AuthenticationRequiredException()
        if (!session.lastUsedAt.plus(properties.sessionIdleTtl).isAfter(now)) throw AuthenticationRequiredException()

        val account = repository.findById(session.accountId) ?: throw AuthenticationRequiredException()
        if (account.isSuspended) throw AccountSuspendedException()

        if (Duration.between(session.lastUsedAt, now) >= TOUCH_INTERVAL) {
            repository.touchSession(tokenHash, now)
        }
        return account
    }

    /** 쿠키의 세션을 삭제합니다. 이미 없거나 만료된 세션도 성공으로 처리하고, 쿠키가 없으면 401입니다. */
    fun logOut(sessionToken: String?) {
        val token = sessionToken?.trim()?.takeIf(String::isNotEmpty) ?: throw AuthenticationRequiredException()
        repository.deleteSessionByTokenHash(SessionTokenHelper.hash(token))
    }

    companion object {
        /** 이 간격 안의 반복 요청은 마지막 사용 시각을 다시 쓰지 않습니다. */
        val TOUCH_INTERVAL: Duration = Duration.ofMinutes(5)
    }
}
