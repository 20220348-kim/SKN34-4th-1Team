package ai.govbiz.core.account.service

import ai.govbiz.core.account.service.exception.LoginRateLimitedException
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.ArrayDeque

/**
 * 로그인 시도를 계정과 접속 주소 기준으로 제한합니다. 한 Core 프로세스의 메모리에만 기록합니다.
 *
 * - 계정: 연속 실패가 [FAILURE_THRESHOLD]에 이르면 잠그고, 실패가 이어질수록 잠금 시간을 두 배로 늘립니다(최대 [MAX_LOCK]).
 *   성공하면 기록을 지웁니다. 비밀번호 추측을 늦추면서 정상 사용자는 짧은 잠금만 겪게 합니다.
 * - 접속 주소: 최근 60초 동안 [ADDRESS_PER_MINUTE]번까지만 시도할 수 있어 여러 계정을 훑는 시도를 막습니다.
 */
class AccountLoginAttemptGuard(
    private val clock: Clock,
) {
    private val lock = Any()
    private val accountFailures = mutableMapOf<String, AccountFailure>()
    private val addressAttempts = mutableMapOf<String, ArrayDeque<Instant>>()

    /** 로그인 검증 전에 호출합니다. 한도를 넘었으면 [LoginRateLimitedException]을 던지고 이번 시도를 기록합니다. */
    fun checkAllowed(email: String, clientAddress: String) {
        synchronized(lock) {
            val now = Instant.now(clock)
            pruneIfLarge(now)

            val failure = accountFailures[email]
            if (failure?.lockedUntil != null && failure.lockedUntil.isAfter(now)) {
                throw LoginRateLimitedException(secondsUntil(now, failure.lockedUntil))
            }
            recordAddressAttempt(clientAddress, now)
        }
    }

    /** 계정 잠금과 무관하게 접속 주소 한도만 검사합니다. 회원가입처럼 아직 계정이 없는 시도에 씁니다. */
    fun checkAddressAllowed(clientAddress: String) {
        synchronized(lock) {
            val now = Instant.now(clock)
            pruneIfLarge(now)
            recordAddressAttempt(clientAddress, now)
        }
    }

    private fun recordAddressAttempt(clientAddress: String, now: Instant) {
        val attempts = addressAttempts.getOrPut(clientAddress) { ArrayDeque() }
        while (attempts.isNotEmpty() && Duration.between(attempts.first, now) >= WINDOW) attempts.removeFirst()
        if (attempts.size >= ADDRESS_PER_MINUTE) {
            throw LoginRateLimitedException(secondsUntil(now, attempts.first.plus(WINDOW)))
        }
        attempts.addLast(now)
    }

    fun recordFailure(email: String) {
        synchronized(lock) {
            val now = Instant.now(clock)
            val count = (accountFailures[email]?.count ?: 0) + 1
            val lockedUntil = if (count >= FAILURE_THRESHOLD) now.plus(lockDuration(count)) else null
            accountFailures[email] = AccountFailure(count, lockedUntil, now)
        }
    }

    fun recordSuccess(email: String) {
        synchronized(lock) {
            accountFailures.remove(email)
        }
    }

    private fun lockDuration(failureCount: Int): Duration {
        val doublings = (failureCount - FAILURE_THRESHOLD).coerceAtMost(MAX_DOUBLINGS)
        return minOf(BASE_LOCK.multipliedBy(1L shl doublings), MAX_LOCK)
    }

    private fun secondsUntil(now: Instant, until: Instant): Int =
        Duration.between(now, until).plusSeconds(1).minusNanos(1).seconds.toInt().coerceAtLeast(1)

    /** 기록이 많이 쌓였을 때만 오래된 항목을 정리해 메모리가 계속 늘지 않게 합니다. */
    private fun pruneIfLarge(now: Instant) {
        if (accountFailures.size > PRUNE_THRESHOLD) {
            accountFailures.values.removeIf { failure -> Duration.between(failure.lastFailureAt, now) >= MAX_LOCK }
        }
        if (addressAttempts.size > PRUNE_THRESHOLD) {
            addressAttempts.values.removeIf { attempts ->
                attempts.isEmpty() || Duration.between(attempts.last, now) >= WINDOW
            }
        }
    }

    private data class AccountFailure(
        val count: Int,
        val lockedUntil: Instant?,
        val lastFailureAt: Instant,
    )

    companion object {
        const val FAILURE_THRESHOLD = 5
        const val ADDRESS_PER_MINUTE = 20
        val BASE_LOCK: Duration = Duration.ofSeconds(30)
        val MAX_LOCK: Duration = Duration.ofMinutes(15)
        private const val MAX_DOUBLINGS = 5
        private val WINDOW: Duration = Duration.ofMinutes(1)
        private const val PRUNE_THRESHOLD = 5_000
    }
}
