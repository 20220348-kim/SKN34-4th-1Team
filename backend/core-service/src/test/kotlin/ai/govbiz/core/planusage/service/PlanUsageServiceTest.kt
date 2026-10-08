package ai.govbiz.core.planusage.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.repository.GuestPlanUsageRepository
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.service.exception.PlanQuotaExceededException
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito

class PlanUsageServiceTest {
    private val seoul = ZoneId.of("Asia/Seoul")
    // 서울 2026-10-08 21:00 — 하루 한도는 3시간 뒤에 다시 채워집니다.
    private val clock = Clock.fixed(Instant.parse("2026-10-08T12:00:00Z"), seoul)
    private val repository = Mockito.mock(PlanUsageRepository::class.java)
    private val guests = Mockito.mock(GuestPlanUsageRepository::class.java)
    private val service = PlanUsageService(repository, guests, clock, "")
    private val member = Account(7, "member@example.test", AccountRole.USER, null, null, LocalDateTime.of(2026, 9, 1, 9, 0))
    private val today = PlanUsageWindow.current(PlanUsagePeriod.DAY, ZonedDateTime.now(clock))

    @Test
    fun keepsTheUseWhenTheActionSucceedsAndGivesItBackWhenItFails() {
        Mockito.doReturn(PlanCode.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(true).`when`(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", 10)

        assertEquals("ranked", service.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { "ranked" })
        Mockito.verify(repository, Mockito.never()).release(7, PlanUsageFeature.AI_SEARCH, "2026-10-08")

        val failure = IllegalStateException("model timeout")
        assertEquals(failure, assertThrows(IllegalStateException::class.java) {
            service.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { throw failure }
        })
        Mockito.verify(repository).release(7, PlanUsageFeature.AI_SEARCH, "2026-10-08")
    }

    @Test
    fun rejectsAtTheDailyLimitWithTheResetTimeAndNeverRunsTheAction() {
        Mockito.doReturn(PlanCode.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(false).`when`(repository).reserve(7, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08", 10)
        var called = false

        val error = assertThrows(PlanQuotaExceededException::class.java) {
            service.consume(member, "192.0.2.1", PlanUsageFeature.EVIDENCE_QUESTION) { called = true }
        }

        assertFalse(called)
        assertEquals(PlanUsageFeature.EVIDENCE_QUESTION, error.feature)
        assertEquals(PlanCode.FREE, error.plan)
        assertEquals(10, error.limit)
        assertEquals(10, error.used)
        assertEquals(ZonedDateTime.of(2026, 10, 9, 0, 0, 0, 0, seoul), error.resetsAt)
        assertEquals(3 * 60 * 60L, error.retryAfterSeconds)
    }

    @Test
    fun guestsOnlyGetTheAiSearchTrialPerAddress() {
        Mockito.doReturn(false).`when`(guests).reserve("192.0.2.9", today, 2)

        val error = assertThrows(PlanQuotaExceededException::class.java) {
            service.consume(null, "192.0.2.9", PlanUsageFeature.AI_SEARCH) { "never" }
        }
        assertNull(error.plan)
        assertEquals(2, error.limit)
        // 원문 질문 같은 다른 AI 기능은 컨트롤러가 로그인부터 요구하므로 여기 오면 잘못 연결된 것입니다.
        assertThrows(IllegalArgumentException::class.java) {
            service.consume(null, "192.0.2.9", PlanUsageFeature.EVIDENCE_QUESTION) { "never" }
        }
        Mockito.verifyNoInteractions(repository)
    }

    @Test
    fun localDevelopmentAccountsAreCountedButNeverBlocked() {
        // 로컬 데모 시드 계정만 개발용 무제한으로 지정합니다. 대소문자와 앞뒤 공백은 가리지 않습니다.
        val dev = PlanUsageService(repository, guests, clock, " Member@Example.test , other@example.test")
        Mockito.doReturn(PlanCode.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(false).`when`(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", null)

        // 하루 10회를 넘겼어도 막지 않고, 사용량은 그대로 셉니다.
        assertEquals("ranked", dev.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { "ranked" })
        Mockito.verify(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", null)
        assertEquals(listOf(null, null), dev.usage(member, "192.0.2.1").items.map { it.limit })

        // 지정이 없는 운영 설정은 FREE 한도를 적용합니다.
        assertEquals(listOf(10, 10), service.usage(member, "192.0.2.1").items.map { it.limit })
    }

    @Test
    fun plansWithoutALimitAreCountedButNeverBlocked() {
        Mockito.doReturn(PlanCode.PREMIUM).`when`(repository).findPlan(7)
        Mockito.doReturn(true).`when`(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", null)

        assertEquals("ranked", service.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { "ranked" })

        // 한도가 없으면 저장소가 더하지 못했다고 답해도 막지 않습니다.
        Mockito.doReturn(false).`when`(repository).reserve(7, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08", null)
        assertEquals("answered", service.consume(member, "192.0.2.1", PlanUsageFeature.EVIDENCE_QUESTION) { "answered" })
    }

    @Test
    fun reportsGuestTrialAndMemberUsageWithNullLimitsForUndecidedPlans() {
        Mockito.doReturn(2).`when`(guests).used("192.0.2.9", today)
        val guest = service.usage(null, "192.0.2.9")
        assertNull(guest.plan)
        assertEquals(listOf(PlanUsageFeature.AI_SEARCH to 2), guest.items.map { it.feature to it.used })
        assertEquals(2, guest.items.single().limit)

        Mockito.doReturn(PlanCode.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(mapOf((PlanUsageFeature.AI_SEARCH to "2026-10-08") to 4))
            .`when`(repository).findCounts(7, listOf("2026-10-08", "2026-10-08"))

        val usage = service.usage(member, "192.0.2.1")

        assertEquals(PlanCode.FREE, usage.plan)
        assertEquals(
            listOf(Triple(PlanUsageFeature.AI_SEARCH, 10, 4), Triple(PlanUsageFeature.EVIDENCE_QUESTION, 10, 0)),
            usage.items.map { Triple(it.feature, it.limit, it.used) },
        )

        Mockito.doReturn(PlanCode.PLUS).`when`(repository).findPlan(7)
        assertEquals(listOf(null, null), service.usage(member, "192.0.2.1").items.map { it.limit })
    }
}
