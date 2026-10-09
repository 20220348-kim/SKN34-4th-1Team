package ai.govbiz.core.planusage.domain

import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class AccountPlanTest {
    private val seoul = ZoneId.of("Asia/Seoul")
    private val starts = ZonedDateTime.of(2026, 10, 1, 15, 30, 0, 0, seoul)
    private val pass = AccountPlan(PlanCode.PLUS, starts, starts.plusDays(30))

    @Test
    fun aPassIsUsedOnlyFromItsStartUntilItEnds() {
        assertSame(AccountPlan.FREE, pass.effectiveAt(starts.minusSeconds(1)))
        assertEquals(pass, pass.effectiveAt(starts))
        assertEquals(pass, pass.effectiveAt(starts.plusDays(30).minusNanos(1)))
        // 끝나는 시각부터는 무료입니다.
        assertSame(AccountPlan.FREE, pass.effectiveAt(starts.plusDays(30)))
        // 끝나는 때가 없는 배정(운영자·검증 계정)은 시작한 뒤 계속 씁니다.
        val operator = AccountPlan(PlanCode.PREMIUM, starts)
        assertEquals(operator, operator.effectiveAt(starts.plusDays(400)))
    }

    @Test
    fun freeCountsBySeoulDayAndMonthWhileAPassCountsItsPeriod() {
        val now = ZonedDateTime.of(2026, 10, 8, 21, 0, 0, 0, seoul)
        assertEquals("2026-10-08", AccountPlan.FREE.windowOf(PlanUsageFeature.AI_SEARCH, now).key)
        assertEquals("2026-10", AccountPlan.FREE.windowOf(PlanUsageFeature.APPLICATION_DRAFT, now).key)
        for (feature in PlanUsageFeature.entries) {
            val window = pass.windowOf(feature, now)
            assertEquals("P20261001T153000", window.key)
            assertEquals(starts.plusDays(30), window.resetsAt)
        }
        assertEquals(500, pass.limitOf(PlanUsageFeature.AI_SEARCH))
    }

    @Test
    fun aDevelopmentAccountKeepsItsPeriodsWithoutLimits() {
        val now = ZonedDateTime.of(2026, 10, 8, 21, 0, 0, 0, seoul)
        val dev = AccountPlan.FREE.withoutLimits()
        assertEquals(null, dev.limitOf(PlanUsageFeature.AI_SEARCH))
        assertEquals("2026-10-08", dev.windowOf(PlanUsageFeature.AI_SEARCH, now).key)
        assertEquals(null, pass.withoutLimits().limitOf(PlanUsageFeature.APPLICATION_DRAFT))
        assertEquals("P20261001T153000", pass.withoutLimits().windowOf(PlanUsageFeature.APPLICATION_DRAFT, now).key)
    }

    @Test
    fun aPaidPlanNeedsAStartAndMustEndAfterIt() {
        assertThrows(IllegalArgumentException::class.java) { AccountPlan(PlanCode.PLUS) }
        assertThrows(IllegalArgumentException::class.java) { AccountPlan(PlanCode.PLUS, starts, starts) }
    }
}
