package ai.govbiz.core.planusage.domain

import java.time.YearMonth
import java.time.ZonedDateTime

/** 한도를 세는 기간입니다. 하루는 서울 자정, 한 달은 서울 기준 매월 1일 0시에 다시 채워집니다. */
enum class PlanUsagePeriod {
    DAY,
    MONTH,
}

/**
 * 요금제 한도로 세는 기능입니다. 하루 한도는 요청마다 세고, 월 한도는 실패하지 않은 작업(진행 중 포함)으로 셉니다.
 * 신청 문서 초안은 공고 하나를 한 건으로 보아 같은 공고의 양식 분석과 문서 생성을 다시 해도 늘지 않습니다.
 */
enum class PlanUsageFeature(val period: PlanUsagePeriod) {
    AI_SEARCH(PlanUsagePeriod.DAY),
    EVIDENCE_QUESTION(PlanUsagePeriod.DAY),
    APPLICATION_DRAFT(PlanUsagePeriod.MONTH),
    COMBINATION_REVIEW(PlanUsagePeriod.MONTH),
}

/** 한 기능의 현재 집계 기간입니다. [key]는 사용량 행을 고르고, [startsAt]~[resetsAt]은 작업 표를 셀 범위입니다. */
data class PlanUsageWindow(val key: String, val startsAt: ZonedDateTime, val resetsAt: ZonedDateTime) {
    companion object {
        fun current(period: PlanUsagePeriod, now: ZonedDateTime): PlanUsageWindow = when (period) {
            PlanUsagePeriod.DAY -> {
                val today = now.toLocalDate()
                PlanUsageWindow(today.toString(), today.atStartOfDay(now.zone), today.plusDays(1).atStartOfDay(now.zone))
            }
            PlanUsagePeriod.MONTH -> {
                val month = YearMonth.from(now)
                PlanUsageWindow(
                    month.toString(),
                    month.atDay(1).atStartOfDay(now.zone),
                    month.plusMonths(1).atDay(1).atStartOfDay(now.zone),
                )
            }
        }
    }
}

/**
 * 월 한도에 들어가는 작업입니다. 방금 만든 작업(ReviewRun·FormDiscovery·DocumentGeneration)은 그 작업을 뺀 사용량과,
 * 작업 표를 남기지 않는 신청 문서 경로의 공고(DraftProgram)는 그 공고를 더한 사용량과 비교해 사용량이 늘어나는지 가립니다.
 */
sealed interface PlanUsageJob {
    val feature: PlanUsageFeature

    data class ReviewRun(val runId: Long) : PlanUsageJob {
        override val feature = PlanUsageFeature.COMBINATION_REVIEW
    }

    data class FormDiscovery(val jobId: Long) : PlanUsageJob {
        override val feature = PlanUsageFeature.APPLICATION_DRAFT
    }

    data class DocumentGeneration(val jobId: Long) : PlanUsageJob {
        override val feature = PlanUsageFeature.APPLICATION_DRAFT
    }

    data class DraftProgram(val sourceCode: String, val sourceProgramId: String) : PlanUsageJob {
        override val feature = PlanUsageFeature.APPLICATION_DRAFT
    }
}
