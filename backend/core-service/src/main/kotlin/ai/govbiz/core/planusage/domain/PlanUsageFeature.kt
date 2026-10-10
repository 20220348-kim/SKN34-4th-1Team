package ai.govbiz.core.planusage.domain

import java.time.Duration
import java.time.YearMonth
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * 한도를 세는 기간입니다. 하루는 서울 자정, 한 달은 서울 기준 매월 1일 0시에 다시 채워집니다.
 * 이용 기간(PLAN)은 유료 요금제의 시작 시각부터 30일씩입니다.
 */
enum class PlanUsagePeriod {
    DAY,
    MONTH,
    PLAN,
}

/**
 * 요금제 한도로 세는 기능입니다. [perRequest]인 기능은 요청마다 사용량 표에 세고, 아닌 기능은 실패하지 않은 작업(진행 중 포함)으로 셉니다.
 * [freePeriod]는 무료 요금제의 기간이며, 유료 요금제는 모든 기능을 이용 기간 총량으로 셉니다.
 * 신청 문서 초안은 공고 하나를 한 건으로 보아 같은 공고의 양식 분석과 문서 생성을 다시 해도 늘지 않습니다.
 */
enum class PlanUsageFeature(val freePeriod: PlanUsagePeriod, val perRequest: Boolean) {
    AI_SEARCH(PlanUsagePeriod.DAY, perRequest = true),
    EVIDENCE_QUESTION(PlanUsagePeriod.DAY, perRequest = true),
    APPLICATION_DRAFT(PlanUsagePeriod.MONTH, perRequest = false),
    COMBINATION_REVIEW(PlanUsagePeriod.MONTH, perRequest = false),
}

/** 한 기능의 현재 집계 기간입니다. [key]는 사용량 행을 고르고, [startsAt]~[resetsAt]은 작업 표를 셀 범위입니다. */
data class PlanUsageWindow(
    val period: PlanUsagePeriod,
    val key: String,
    val startsAt: ZonedDateTime,
    val resetsAt: ZonedDateTime,
) {
    companion object {
        /** 유료 이용 기간 한 번의 길이입니다. */
        const val PLAN_PERIOD_DAYS = 30L
        private val PLAN_KEY = DateTimeFormatter.ofPattern("'P'yyyyMMdd'T'HHmmss")

        /** 무료 요금제와 로그인 전 체험의 서울 하루·달 기간입니다. */
        fun current(period: PlanUsagePeriod, now: ZonedDateTime): PlanUsageWindow = when (period) {
            PlanUsagePeriod.DAY -> {
                val today = now.toLocalDate()
                PlanUsageWindow(period, today.toString(), today.atStartOfDay(now.zone), today.plusDays(1).atStartOfDay(now.zone))
            }
            PlanUsagePeriod.MONTH -> {
                val month = YearMonth.from(now)
                PlanUsageWindow(
                    period,
                    month.toString(),
                    month.atDay(1).atStartOfDay(now.zone),
                    month.plusMonths(1).atDay(1).atStartOfDay(now.zone),
                )
            }
            PlanUsagePeriod.PLAN -> throw IllegalArgumentException("A plan period needs the plan start")
        }

        /**
         * 유료 요금제의 지금 이용 기간입니다. [startsAt]부터 30일씩 나눈 기간 중 [now]가 든 기간이며, 키는 그 기간이 시작한 서울 시각
         * (예: P20261020T153000)입니다. [endsAt]이 그 기간 안이면 그때 끝납니다(30일 이용권은 첫 기간이 곧 이용권 기간입니다).
         */
        fun plan(startsAt: ZonedDateTime, endsAt: ZonedDateTime?, now: ZonedDateTime): PlanUsageWindow {
            require(!now.isBefore(startsAt)) { "The plan has not started yet" }
            val index = Duration.between(startsAt, now).toDays() / PLAN_PERIOD_DAYS
            val start = startsAt.plusDays(index * PLAN_PERIOD_DAYS)
            val next = start.plusDays(PLAN_PERIOD_DAYS)
            val resetsAt = if (endsAt != null && endsAt.isBefore(next)) endsAt else next
            return PlanUsageWindow(PlanUsagePeriod.PLAN, start.format(PLAN_KEY), start, resetsAt)
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
