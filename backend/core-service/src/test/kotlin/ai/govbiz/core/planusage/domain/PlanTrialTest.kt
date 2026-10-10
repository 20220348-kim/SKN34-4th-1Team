package ai.govbiz.core.planusage.domain

import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PlanTrialTest {
    private val starts = ZonedDateTime.of(2026, 10, 1, 15, 30, 0, 0, ZoneId.of("Asia/Seoul"))

    @Test
    fun freeMembersCanTryEachPaidPlanOnce() {
        assertEquals(listOf(PlanCode.PLUS, PlanCode.PREMIUM), PlanTrial.available(AccountPlan.FREE, emptySet()))
        assertEquals(listOf(PlanCode.PREMIUM), PlanTrial.available(AccountPlan.FREE, setOf(PlanCode.PLUS)))
        // 프리미엄 체험이 끝난 뒤에도 아직 쓰지 않은 플러스 체험은 남습니다.
        assertEquals(listOf(PlanCode.PLUS), PlanTrial.available(AccountPlan.FREE, setOf(PlanCode.PREMIUM)))
        assertEquals(emptyList<PlanCode>(), PlanTrial.available(AccountPlan.FREE, setOf(PlanCode.PLUS, PlanCode.PREMIUM)))
    }

    @Test
    fun aTrialCanMoveOnlyUpAndAnOperatorAssignmentCannotStartOne() {
        val plusTrial = AccountPlan(PlanCode.PLUS, starts, starts.plusDays(PlanTrial.DAYS), source = PlanSource.TRIAL)
        assertEquals(listOf(PlanCode.PREMIUM), PlanTrial.available(plusTrial, setOf(PlanCode.PLUS)))
        val premiumTrial = AccountPlan(PlanCode.PREMIUM, starts, starts.plusDays(PlanTrial.DAYS), source = PlanSource.TRIAL)
        assertEquals(emptyList<PlanCode>(), PlanTrial.available(premiumTrial, setOf(PlanCode.PREMIUM)))
        // 운영자가 배정한 이용권(검증·제휴 계정, 결제 전 이용권)을 쓰는 동안은 체험으로 바꾸지 않습니다.
        val operator = AccountPlan(PlanCode.PLUS, starts, starts.plusDays(30), source = PlanSource.OPERATOR)
        assertEquals(emptyList<PlanCode>(), PlanTrial.available(operator, emptySet()))
    }
}
