package ai.govbiz.core.planusage.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** MyBatis가 사용량 한 행을 읽기 위한 DB 행 값입니다. */
data class PlanUsageCounterDbRow(
    var feature: String = "",
    var periodKey: String = "",
    var usedCount: Int = 0,
)

/** 계정에 배정한 요금제 한 행입니다. [endsAt]이 없으면 끝나는 때가 없는 배정입니다. */
data class AccountPlanDbRow(
    var planCode: String = "",
    var assignedAt: LocalDateTime? = null,
    var endsAt: LocalDateTime? = null,
)

/** 작업 표를 남기지 않는 신청 문서 경로가 AI 전에 남기는 공고 기록 한 행입니다. */
data class PlanUsageDraftProgramDbRow(
    var id: Long = 0,
    var accountId: Long = 0,
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var createdAt: LocalDateTime? = null,
)

/**
 * 요금제(`account_plan`)와 사용량(`plan_usage_counter`·`plan_usage_draft_program`) SQL,
 * 월 한도 기능의 작업 표 집계를 실행하는 MyBatis Mapper입니다.
 */
@Mapper
interface PlanUsageMapper {
    fun findPlan(@Param("accountId") accountId: Long): AccountPlanDbRow?

    /** 탈퇴하지 않은 계정 행을 잠그고 ID를 돌려줍니다. 없으면 null입니다. */
    fun lockAccount(@Param("accountId") accountId: Long): Long?

    fun insertDraftProgram(row: PlanUsageDraftProgramDbRow): Int

    fun deleteDraftProgram(@Param("id") id: Long): Int

    /** 한도보다 적을 때만 1을 더합니다. 영향받은 행이 0이면 이미 한도입니다. [limit]이 null이면 조건 없이 더합니다. */
    fun incrementWithin(
        @Param("accountId") accountId: Long,
        @Param("feature") feature: String,
        @Param("periodKey") periodKey: String,
        @Param("limit") limit: Int?,
        @Param("now") now: LocalDateTime,
    ): Int

    /** 그 기간의 행이 없으면 0으로 만들고, 있으면 그대로 둔 채 행을 잠급니다. */
    fun ensureCounter(
        @Param("accountId") accountId: Long,
        @Param("feature") feature: String,
        @Param("periodKey") periodKey: String,
        @Param("now") now: LocalDateTime,
    ): Int

    fun decrement(
        @Param("accountId") accountId: Long,
        @Param("feature") feature: String,
        @Param("periodKey") periodKey: String,
        @Param("now") now: LocalDateTime,
    ): Int

    fun addCount(
        @Param("accountId") accountId: Long,
        @Param("feature") feature: String,
        @Param("periodKey") periodKey: String,
        @Param("amount") amount: Int,
        @Param("now") now: LocalDateTime,
    ): Int

    fun findCounts(
        @Param("accountId") accountId: Long,
        @Param("periodKeys") periodKeys: List<String>,
    ): List<PlanUsageCounterDbRow>

    fun countChargeableReviewRuns(
        @Param("accountId") accountId: Long,
        @Param("from") from: LocalDateTime,
        @Param("to") to: LocalDateTime,
        @Param("excludeRunId") excludeRunId: Long?,
    ): Int

    fun countChargeableDraftPrograms(
        @Param("accountId") accountId: Long,
        @Param("from") from: LocalDateTime,
        @Param("to") to: LocalDateTime,
        @Param("excludeDiscoveryJobId") excludeDiscoveryJobId: Long?,
        @Param("excludeGenerationJobId") excludeGenerationJobId: Long?,
        @Param("includeSourceCode") includeSourceCode: String?,
        @Param("includeSourceProgramId") includeSourceProgramId: String?,
    ): Int
}
