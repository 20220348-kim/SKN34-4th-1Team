package ai.govbiz.core.planusage.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.service.dto.PlanUsageResult
import org.springframework.stereotype.Service

/** 계정의 현재 요금제를 알려 줍니다. 결제 연동 전이라 운영자가 배정하지 않은 회원은 모두 FREE입니다. */
@Service
class PlanUsageService(
    private val repository: PlanUsageRepository,
) {
    /** 현재 요금제입니다. 로그인하지 않았으면 요금제가 없습니다. */
    fun usage(account: Account?): PlanUsageResult =
        PlanUsageResult(account?.let { repository.findPlan(it.id) })
}
