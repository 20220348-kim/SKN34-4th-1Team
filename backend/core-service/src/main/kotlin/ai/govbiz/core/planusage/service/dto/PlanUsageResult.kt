package ai.govbiz.core.planusage.service.dto

import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import java.time.ZonedDateTime

/** 현재 요금제와 기능별 사용량입니다. 로그인하지 않았으면 [plan]이 null이고 체험 기능만 담습니다. */
data class PlanUsageResult(val plan: PlanCode?, val items: List<PlanUsageItem>)

/** 한 기능의 이번 기간 사용량입니다. [limit]이 null이면 그 요금제는 아직 한도가 없어 제한하지 않습니다. */
data class PlanUsageItem(val feature: PlanUsageFeature, val limit: Int?, val used: Int, val resetsAt: ZonedDateTime)
