package ai.govbiz.core.planusage.repository

import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.repository.exception.PlanUsageStoreException
import ai.govbiz.core.planusage.repository.mapper.PlanUsageMapper
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.dao.DataAccessException
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 계정 요금제와 사용량을 MySQL에 저장하고 읽습니다. 저장소 오류는 한도를 확인할 수 없다는 예외로만 바꿉니다. */
@Repository
class PlanUsageRepository(
    private val mapper: PlanUsageMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun findPlan(accountId: Long): PlanCode = store {
        mapper.findPlanCode(accountId)?.let(PlanCode::valueOf) ?: PlanCode.FREE
    }

    /**
     * 한도 안일 때만 1을 더하고 더했는지 돌려줍니다. 먼저 그 기간의 행을 만들거나 잠그고 조건부 UPDATE 한 문장으로 더하므로,
     * 같은 계정의 요청이 동시에 와도 한도를 넘겨 더하지 않습니다. [limit]이 null(제한 없음)이면 사용량만 남기도록 항상 더합니다.
     */
    @Transactional
    fun reserve(accountId: Long, feature: PlanUsageFeature, periodKey: String, limit: Int?): Boolean = store {
        val now = now()
        mapper.ensureCounter(accountId, feature.name, periodKey, now)
        mapper.incrementWithin(accountId, feature.name, periodKey, limit, now) == 1
    }

    fun release(accountId: Long, feature: PlanUsageFeature, periodKey: String) {
        store { mapper.decrement(accountId, feature.name, periodKey, now()) }
    }

    fun findCounts(accountId: Long, periodKeys: Collection<String>): Map<Pair<PlanUsageFeature, String>, Int> = store {
        mapper.findCounts(accountId, periodKeys.distinct()).associate {
            (PlanUsageFeature.valueOf(it.feature) to it.periodKey) to it.usedCount
        }
    }

    private fun now(): LocalDateTime = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)

    private fun <T> store(operation: () -> T): T = try {
        operation()
    } catch (error: DataAccessException) {
        throw PlanUsageStoreException(error)
    }
}
