package ai.govbiz.core.planusage.domain

import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.jupiter.api.Assertions.assertEquals
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
    fun onlyFreeHasLimitsUntilPaidPlansAreDecided() {
        assertEquals(listOf(10, 10), PlanUsageFeature.entries.map(PlanCode.FREE::limitOf))
        // PLUS·PREMIUM은 아직 숫자를 정하지 않아 제한하지 않습니다.
        assertEquals(listOf(null, null), PlanUsageFeature.entries.map(PlanCode.PLUS::limitOf))
        assertEquals(listOf(null, null), PlanUsageFeature.entries.map(PlanCode.PREMIUM::limitOf))
        assertEquals(2, PlanCode.GUEST_AI_SEARCH_PER_DAY)
        assertEquals(PlanUsagePeriod.DAY, PlanUsageFeature.AI_SEARCH.period)
        assertEquals(PlanUsagePeriod.DAY, PlanUsageFeature.EVIDENCE_QUESTION.period)
    }
}
