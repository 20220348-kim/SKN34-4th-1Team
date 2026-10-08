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

/** 요금제(`account_plan`)와 사용량(`plan_usage_counter`) SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface PlanUsageMapper {
    fun findPlanCode(@Param("accountId") accountId: Long): String?

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

    fun findCounts(
        @Param("accountId") accountId: Long,
        @Param("periodKeys") periodKeys: List<String>,
    ): List<PlanUsageCounterDbRow>
}
