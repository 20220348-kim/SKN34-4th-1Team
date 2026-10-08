package ai.govbiz.core.planusage.repository

import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.repository.mapper.PlanUsageMapper
import org.springframework.stereotype.Repository

/** 계정 요금제를 MySQL에서 읽습니다. 배정한 행이 없으면 FREE입니다. */
@Repository
class PlanUsageRepository(
    private val mapper: PlanUsageMapper,
) {
    fun findPlan(accountId: Long): PlanCode =
        mapper.findPlanCode(accountId)?.let(PlanCode::valueOf) ?: PlanCode.FREE
}
