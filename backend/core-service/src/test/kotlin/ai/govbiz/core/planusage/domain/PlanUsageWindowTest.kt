package ai.govbiz.core.planusage.domain

import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class PlanUsageWindowTest {
    private val seoul = ZoneId.of("Asia/Seoul")

    @Test
    fun dailyWindowsUseTheSeoulDateAndResetAtTheNextSeoulMidnight() {
        // UTC로는 아직 10월 31일이지만 서울은 11월 1일입니다.
        val now = ZonedDateTime.of(2026, 11, 1, 0, 30, 0, 0, seoul)
        val window = PlanUsageWindow.current(PlanUsagePeriod.DAY, now)
        assertEquals("2026-11-01", window.key)
        assertEquals(ZonedDateTime.of(2026, 11, 1, 0, 0, 0, 0, seoul), window.startsAt)
        assertEquals(ZonedDateTime.of(2026, 11, 2, 0, 0, 0, 0, seoul), window.resetsAt)
    }

    @Test
    fun monthlyWindowsCoverTheWholeSeoulMonthIncludingTheYearBoundary() {
        val now = ZonedDateTime.of(2026, 12, 31, 23, 59, 59, 0, seoul)
        val window = PlanUsageWindow.current(PlanUsagePeriod.MONTH, now)
        assertEquals("2026-12", window.key)
        assertEquals(ZonedDateTime.of(2026, 12, 1, 0, 0, 0, 0, seoul), window.startsAt)
        assertEquals(ZonedDateTime.of(2027, 1, 1, 0, 0, 0, 0, seoul), window.resetsAt)
    }

    @Test
    fun aPlanPeriodRepeatsEveryThirtyDaysFromItsStartAndStopsAtTheEnd() {
        val starts = ZonedDateTime.of(2026, 9, 1, 9, 0, 0, 0, seoul)
        // 끝나는 때가 없으면 시작 시각부터 30일마다 새 기간이고, 키는 기간이 시작한 서울 시각입니다.
        val second = PlanUsageWindow.plan(starts, null, ZonedDateTime.of(2026, 10, 8, 21, 0, 0, 0, seoul))
        assertEquals(PlanUsagePeriod.PLAN, second.period)
        assertEquals("P20261001T090000", second.key)
        assertEquals(ZonedDateTime.of(2026, 10, 1, 9, 0, 0, 0, seoul), second.startsAt)
        assertEquals(ZonedDateTime.of(2026, 10, 31, 9, 0, 0, 0, seoul), second.resetsAt)
        // 기간이 바뀌는 바로 그 시각부터 다음 기간입니다.
        assertEquals("P20261031T090000", PlanUsageWindow.plan(starts, null, ZonedDateTime.of(2026, 10, 31, 9, 0, 0, 0, seoul)).key)
        assertEquals("P20261001T090000", PlanUsageWindow.plan(starts, null, ZonedDateTime.of(2026, 10, 31, 8, 59, 59, 0, seoul)).key)

        // 30일 이용권은 첫 기간이 곧 이용권 기간이고, 끝나는 때가 기간 안이면 그때 끝납니다.
        val pass = PlanUsageWindow.plan(starts, starts.plusDays(30), ZonedDateTime.of(2026, 9, 15, 0, 0, 0, 0, seoul))
        assertEquals("P20260901T090000", pass.key)
        assertEquals(ZonedDateTime.of(2026, 10, 1, 9, 0, 0, 0, seoul), pass.resetsAt)
        val shortened = PlanUsageWindow.plan(starts, starts.plusDays(10), ZonedDateTime.of(2026, 9, 5, 0, 0, 0, 0, seoul))
        assertEquals(starts.plusDays(10), shortened.resetsAt)

        assertThrows(IllegalArgumentException::class.java) { PlanUsageWindow.plan(starts, null, starts.minusSeconds(1)) }
        assertThrows(IllegalArgumentException::class.java) { PlanUsageWindow.current(PlanUsagePeriod.PLAN, starts) }
    }

    @Test
    fun freeCountsPerDayAndMonthWhilePaidPassesCountThirtyDayTotals() {
        assertEquals(listOf(10, 10, 3, 3), PlanUsageFeature.entries.map(PlanCode.FREE::limitOf))
        assertEquals(listOf(500, 500, 5, 10), PlanUsageFeature.entries.map(PlanCode.PLUS::limitOf))
        assertEquals(listOf(1500, 1500, 20, 40), PlanUsageFeature.entries.map(PlanCode.PREMIUM::limitOf))
        assertEquals(2, PlanCode.GUEST_AI_SEARCH_PER_DAY)
        assertEquals(listOf(PlanUsagePeriod.DAY, PlanUsagePeriod.DAY, PlanUsagePeriod.MONTH, PlanUsagePeriod.MONTH),
            PlanUsageFeature.entries.map { it.freePeriod })
        assertEquals(listOf(true, true, false, false), PlanUsageFeature.entries.map { it.perRequest })
    }
}
