package ai.govbiz.core.account.repository

import ai.govbiz.core.account.domain.AccountOAuthUnlinkJob
import ai.govbiz.core.account.repository.mapper.AccountOAuthIdentityMapper
import ai.govbiz.core.account.repository.mapper.AccountOAuthUnlinkJobMapper
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

@Repository
class AccountOAuthUnlinkRepository(
    private val mapper: AccountOAuthUnlinkJobMapper,
    private val identities: AccountOAuthIdentityMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    /** 탈퇴 Service의 transaction에 참여한다. 같은 탈퇴 작업을 다시 넣어도 상태를 초기화하지 않는다. */
    @Transactional
    fun enqueue(accountId: Long, subject: String) {
        mapper.enqueue(accountId, subject, LocalDateTime.now(clock))
    }

    fun pending(): List<Long> = mapper.pending(LocalDateTime.now(clock))

    fun reservePublication(id: Long): Boolean {
        val now = LocalDateTime.now(clock)
        return mapper.reservePublication(id, now, now.plusMinutes(1)) == 1
    }

    fun markPublished(id: Long) { mapper.markPublished(id, LocalDateTime.now(clock)) }

    @Transactional
    fun claim(id: Long): AccountOAuthUnlinkJob? {
        if (mapper.claim(id, LocalDateTime.now(clock)) != 1) return null
        val row = requireNotNull(mapper.findById(id))
        return AccountOAuthUnlinkJob(row.id, row.accountId, row.subject)
    }

    /** 결과 저장과 정확히 이전 계정이 소유한 identity 해제는 원자적이다. 늦게 도착한 성공은 UNKNOWN을 덮지 않는다. */
    @Transactional
    fun succeed(job: AccountOAuthUnlinkJob): Boolean {
        if (mapper.finish(job.id, "SUCCEEDED", null, LocalDateTime.now(clock)) != 1) return false
        check(identities.deleteKakaoIdentity(job.accountId, job.subject) == 1) { "Original OAuth identity was not retained" }
        return true
    }

    fun failUnconfigured(id: Long): Boolean =
        mapper.finish(id, "FAILED", "NOT_CONFIGURED", LocalDateTime.now(clock)) == 1

    fun markUnknown(id: Long, failureCode: String): Boolean =
        mapper.finish(id, "UNKNOWN", failureCode, LocalDateTime.now(clock)) == 1

    fun expireRunning() {
        val now = LocalDateTime.now(clock)
        // 외부 호출을 이미 시작했을 수 있으므로 재시도하지 않는다. 긴 HTTP 타임아웃도 성공으로 추정하지 않는다.
        mapper.expireRunning(now.minusMinutes(5), now)
    }
}
