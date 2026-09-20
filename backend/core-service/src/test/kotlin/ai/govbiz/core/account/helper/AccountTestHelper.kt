package ai.govbiz.core.account.helper

import ai.govbiz.core.account.config.AccountDevLoginProperties
import ai.govbiz.core.account.config.AccountSessionProperties
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.CompanySummary
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import org.mockito.Mockito

/** account 기능 테스트가 함께 쓰는 고정 시계·설정·계정 예시입니다. */
object AccountTestHelper {

    val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")

    /** 2026-09-06T12:00:00+09:00 */
    val FIXED_CLOCK: Clock = Clock.fixed(Instant.parse("2026-09-06T03:00:00Z"), SEOUL)

    /** FIXED_CLOCK의 서울 현지 시각입니다. */
    val NOW: LocalDateTime = LocalDateTime.of(2026, 9, 6, 12, 0)

    val SESSION_TTL: Duration = Duration.ofDays(30)
    val SESSION_SHORT_TTL: Duration = Duration.ofHours(12)
    val SESSION_IDLE_TTL: Duration = Duration.ofDays(7)

    const val JWT_SECRET = "test-jwt-secret-0123456789abcdef0123456789"

    fun sessionProperties(cookieSecure: Boolean = false): AccountSessionProperties =
        AccountSessionProperties(SESSION_TTL, JWT_SECRET, cookieSecure, SESSION_SHORT_TTL, SESSION_IDLE_TTL)

    fun cookieHelper(cookieSecure: Boolean = false): SessionCookieHelper = SessionCookieHelper(sessionProperties(cookieSecure))

    fun devLoginProperties(
        email: String = "admin@govbiz.local",
        password: String = "govbiz-admin1",
        memberEmail: String = "member@govbiz.local",
    ): AccountDevLoginProperties =
        AccountDevLoginProperties(true, email, password, memberEmail)

    fun account(
        id: Long = 1L,
        email: String = "manager@company.co.kr",
        role: AccountRole = AccountRole.USER,
        emailVerifiedAt: LocalDateTime? = null,
        suspendedAt: LocalDateTime? = null,
        company: CompanySummary? = null,
    ): Account =
        Account(
            id = id,
            email = email,
            role = role,
            emailVerifiedAt = emailVerifiedAt,
            suspendedAt = suspendedAt,
            createdAt = NOW,
            company = company,
        )

    /** Kotlin의 non-null 인자에 Mockito matcher를 넘길 수 있게 null을 T로 다룹니다. */
    @Suppress("UNCHECKED_CAST")
    fun <T> anyValue(): T = Mockito.any<T>() as T
}
