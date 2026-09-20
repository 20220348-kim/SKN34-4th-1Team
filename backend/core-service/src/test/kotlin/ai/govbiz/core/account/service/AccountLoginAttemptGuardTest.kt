package ai.govbiz.core.account.service

import ai.govbiz.core.account.service.exception.LoginRateLimitedException
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class AccountLoginAttemptGuardTest {

    private var now: Instant = Instant.parse("2026-09-06T03:00:00Z")
    private val guard = AccountLoginAttemptGuard(object : Clock() {
        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: java.time.ZoneId?) = this
        override fun instant() = now
    })

    @Test
    fun locksTheAccountAfterFiveFailuresAndDoublesTheLockOnFurtherFailures() {
        repeat(4) {
            guard.checkAllowed(EMAIL, ADDRESS)
            guard.recordFailure(EMAIL)
        }
        assertDoesNotThrow { guard.checkAllowed(EMAIL, ADDRESS) }
        guard.recordFailure(EMAIL)

        assertEquals(30, assertThrows(LoginRateLimitedException::class.java) { guard.checkAllowed(EMAIL, ADDRESS) }.retryAfterSeconds)

        now = now.plusSeconds(30)
        assertDoesNotThrow { guard.checkAllowed(EMAIL, ADDRESS) }
        guard.recordFailure(EMAIL)
        assertEquals(60, assertThrows(LoginRateLimitedException::class.java) { guard.checkAllowed(EMAIL, ADDRESS) }.retryAfterSeconds)

        // 다른 계정과 다른 주소는 영향을 받지 않습니다.
        assertDoesNotThrow { guard.checkAllowed("other@company.co.kr", "10.0.0.2") }
    }

    @Test
    fun capsTheLockAtFifteenMinutesAndClearsItOnSuccess() {
        repeat(20) {
            now = now.plus(Duration.ofMinutes(20))
            guard.checkAllowed(EMAIL, ADDRESS)
            guard.recordFailure(EMAIL)
        }

        val retryAfter = assertThrows(LoginRateLimitedException::class.java) { guard.checkAllowed(EMAIL, ADDRESS) }.retryAfterSeconds
        assertEquals(15 * 60, retryAfter)

        now = now.plus(Duration.ofMinutes(15))
        guard.checkAllowed(EMAIL, ADDRESS)
        guard.recordSuccess(EMAIL)
        guard.recordFailure(EMAIL)
        assertDoesNotThrow { guard.checkAllowed(EMAIL, ADDRESS) }
    }

    @Test
    fun limitsAttemptsPerAddressWithinAMinuteRegardlessOfTheAccount() {
        repeat(AccountLoginAttemptGuard.ADDRESS_PER_MINUTE) { index ->
            guard.checkAllowed("user$index@company.co.kr", ADDRESS)
        }

        val exception = assertThrows(LoginRateLimitedException::class.java) {
            guard.checkAllowed("another@company.co.kr", ADDRESS)
        }
        assertEquals(60, exception.retryAfterSeconds)

        now = now.plusSeconds(60)
        assertDoesNotThrow { guard.checkAllowed("another@company.co.kr", ADDRESS) }
    }

    @Test
    fun addressOnlyChecksShareTheSameWindowAsLoginAttempts() {
        repeat(AccountLoginAttemptGuard.ADDRESS_PER_MINUTE - 1) { guard.checkAddressAllowed(ADDRESS) }
        assertDoesNotThrow { guard.checkAllowed(EMAIL, ADDRESS) }

        assertThrows(LoginRateLimitedException::class.java) { guard.checkAddressAllowed(ADDRESS) }
        assertDoesNotThrow { guard.checkAddressAllowed("10.0.0.2") }
    }

    private companion object {
        const val EMAIL = "manager@company.co.kr"
        const val ADDRESS = "10.0.0.1"
    }
}
