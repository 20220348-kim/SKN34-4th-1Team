package ai.govbiz.core.planusage.repository.mapper

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 요금제(`account_plan`) SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface PlanUsageMapper {
    fun findPlanCode(@Param("accountId") accountId: Long): String?
}
