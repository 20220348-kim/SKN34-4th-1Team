package ai.govbiz.core.planusage.service.dto

import ai.govbiz.core.planusage.domain.PlanCode

/** 현재 요금제입니다. 로그인하지 않았으면 [plan]이 null입니다. */
data class PlanUsageResult(val plan: PlanCode?)
