package ai.govbiz.core.planusage.domain

import java.time.ZonedDateTime

/** 한도를 세는 기간입니다. 하루는 서울 자정에 다시 채워집니다. */
enum class PlanUsagePeriod {
    DAY,
}

/** 요금제 한도로 세는 기능입니다. 하루 한도 기능은 AI를 부르는 요청마다 셉니다. */
enum class PlanUsageFeature(val period: PlanUsagePeriod) {
    AI_SEARCH(PlanUsagePeriod.DAY),
    EVIDENCE_QUESTION(PlanUsagePeriod.DAY),
}

/** 한 기능의 현재 집계 기간입니다. [key]는 사용량 행을 고르고, [startsAt]~[resetsAt]이 그 기간입니다. */
data class PlanUsageWindow(val key: String, val startsAt: ZonedDateTime, val resetsAt: ZonedDateTime) {
    companion object {
        fun current(period: PlanUsagePeriod, now: ZonedDateTime): PlanUsageWindow = when (period) {
            PlanUsagePeriod.DAY -> {
                val today = now.toLocalDate()
                PlanUsageWindow(today.toString(), today.atStartOfDay(now.zone), today.plusDays(1).atStartOfDay(now.zone))
            }
        }
    }
}
