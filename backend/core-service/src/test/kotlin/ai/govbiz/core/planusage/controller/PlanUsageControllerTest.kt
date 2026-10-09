package ai.govbiz.core.planusage.controller

import ai.govbiz.core.planusage.PlanUsageTestHelper
import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.planusage.domain.AccountPlan
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.repository.GuestPlanUsageRepository
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.repository.exception.PlanUsageStoreException
import ai.govbiz.core.planusage.service.PlanUsageService
import ai.govbiz.core.planusage.service.exception.PlanQuotaExceededException
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.hamcrest.Matchers.nullValue
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class PlanUsageControllerTest {
    private val seoul = ZoneId.of("Asia/Seoul")
    private val clock = Clock.fixed(Instant.parse("2026-10-08T12:00:00Z"), seoul)
    private val repository = Mockito.mock(PlanUsageRepository::class.java)
    private val guests = Mockito.mock(GuestPlanUsageRepository::class.java)
    private val sessions = Mockito.mock(AccountSessionService::class.java)
    private val member = Account(7, "member@example.test", AccountRole.USER, null, null, LocalDateTime.of(2026, 9, 1, 9, 0))
    private val today = PlanUsageWindow.current(PlanUsagePeriod.DAY, ZonedDateTime.now(clock))
    private val thisMonth = PlanUsageWindow.current(PlanUsagePeriod.MONTH, ZonedDateTime.now(clock))

    private fun mvc(): MockMvc = MockMvcBuilders.standaloneSetup(PlanUsageController(PlanUsageService(repository, guests, clock, PlanUsageTestHelper.noTransactions(), Mockito.mock(AccountRepository::class.java), "")))
        .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver({ sessions }, { AccountTestHelper.cookieHelper() }))
        .setControllerAdvice(ApiExceptionHandler()).build()

    @Test
    fun guestsSeeOnlyTheirAiSearchTrialForTheConnectingAddress() {
        Mockito.doReturn(1).`when`(guests).used("192.0.2.9", today)

        mvc().perform(get("/api/v1/plan-usage").with { it.remoteAddr = "192.0.2.9"; it })
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.plan").value(nullValue()))
            .andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].feature").value("AI_SEARCH"))
            .andExpect(jsonPath("$.items[0].period").value("DAY"))
            .andExpect(jsonPath("$.items[0].limit").value(2))
            .andExpect(jsonPath("$.items[0].used").value(1))
            .andExpect(jsonPath("$.items[0].resetsAt").value("2026-10-09T00:00:00+09:00"))
    }

    @Test
    fun membersSeeEveryFeatureOfTheirPlan() {
        Mockito.doReturn(member).`when`(sessions).requireAccount("member-token")
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(mapOf((PlanUsageFeature.EVIDENCE_QUESTION to "2026-10-08") to 3, (PlanUsageFeature.COMBINATION_REVIEW to "2026-10") to 1))
            .`when`(repository).findCounts(7, listOf("2026-10-08", "2026-10-08", "2026-10", "2026-10"))
        Mockito.doReturn(0).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, null)
        Mockito.doReturn(1).`when`(repository).countJobs(7, PlanUsageFeature.COMBINATION_REVIEW, thisMonth, null, null)

        mvc().perform(get("/api/v1/plan-usage").header(HttpHeaders.AUTHORIZATION, "Bearer member-token"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.plan").value("FREE"))
            .andExpect(jsonPath("$.planEndsAt").value(nullValue()))
            .andExpect(jsonPath("$.items.length()").value(4))
            .andExpect(jsonPath("$.items[0].feature").value("AI_SEARCH"))
            .andExpect(jsonPath("$.items[0].limit").value(10))
            .andExpect(jsonPath("$.items[0].used").value(0))
            .andExpect(jsonPath("$.items[1].feature").value("EVIDENCE_QUESTION"))
            .andExpect(jsonPath("$.items[1].limit").value(10))
            .andExpect(jsonPath("$.items[1].used").value(3))
            .andExpect(jsonPath("$.items[1].period").value("DAY"))
            .andExpect(jsonPath("$.items[1].resetsAt").value("2026-10-09T00:00:00+09:00"))
            .andExpect(jsonPath("$.items[2].feature").value("APPLICATION_DRAFT"))
            .andExpect(jsonPath("$.items[2].limit").value(3))
            .andExpect(jsonPath("$.items[3].feature").value("COMBINATION_REVIEW"))
            .andExpect(jsonPath("$.items[3].limit").value(3))
            .andExpect(jsonPath("$.items[3].used").value(2))
            .andExpect(jsonPath("$.items[3].period").value("MONTH"))
            .andExpect(jsonPath("$.items[3].resetsAt").value("2026-11-01T00:00:00+09:00"))
    }

    @Test
    fun aPassSendsItsThirtyDayPeriodUsageAndWhenThePassEnds() {
        Mockito.doReturn(member).`when`(sessions).requireAccount("member-token")
        // 10월 1일 15:30에 시작한 프리미엄 30일 이용권입니다.
        val starts = ZonedDateTime.of(2026, 10, 1, 15, 30, 0, 0, seoul)
        Mockito.doReturn(AccountPlan(PlanCode.PREMIUM, starts, starts.plusDays(30))).`when`(repository).findPlan(7)
        val period = PlanUsageWindow.plan(starts, starts.plusDays(30), ZonedDateTime.now(clock))
        Mockito.doReturn(mapOf((PlanUsageFeature.AI_SEARCH to "P20261001T153000") to 42))
            .`when`(repository).findCounts(7, listOf("P20261001T153000", "P20261001T153000", "P20261001T153000", "P20261001T153000"))
        Mockito.doReturn(5).`when`(repository).countJobs(7, PlanUsageFeature.COMBINATION_REVIEW, period, null, null)

        mvc().perform(get("/api/v1/plan-usage").header(HttpHeaders.AUTHORIZATION, "Bearer member-token"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.plan").value("PREMIUM"))
            .andExpect(jsonPath("$.planEndsAt").value("2026-10-31T15:30:00+09:00"))
            .andExpect(jsonPath("$.items[0].period").value("PLAN"))
            .andExpect(jsonPath("$.items[0].limit").value(1500))
            .andExpect(jsonPath("$.items[0].used").value(42))
            .andExpect(jsonPath("$.items[0].resetsAt").value("2026-10-31T15:30:00+09:00"))
            .andExpect(jsonPath("$.items[2].limit").value(20))
            .andExpect(jsonPath("$.items[3].period").value("PLAN"))
            .andExpect(jsonPath("$.items[3].limit").value(40))
            .andExpect(jsonPath("$.items[3].used").value(5))
    }

    @Test
    fun quotaExceededIsA429WithTheResetTimeAndDiffersFromTheRateLimitCode() {
        val request = MockHttpServletRequest("GET", "/api/v1/support-programs/search")
        val response = ApiExceptionHandler().handlePlanQuotaExceeded(
            PlanQuotaExceededException(
                PlanUsageFeature.AI_SEARCH, PlanUsagePeriod.DAY, PlanCode.FREE, 10, 10, ZonedDateTime.of(2026, 10, 9, 0, 0, 0, 0, seoul), 10_800,
            ),
            request,
        )

        assertEquals(HttpStatus.TOO_MANY_REQUESTS, response.statusCode)
        assertEquals("10800", response.headers.getFirst(HttpHeaders.RETRY_AFTER))
        assertEquals("no-store", response.headers.getFirst(HttpHeaders.CACHE_CONTROL))
        val properties = requireNotNull(response.body?.properties)
        assertEquals("PLAN_QUOTA_EXCEEDED", properties["code"])
        assertEquals("AI_SEARCH", properties["feature"])
        assertEquals("DAY", properties["period"])
        assertEquals("FREE", properties["plan"])
        assertEquals(10, properties["limit"])
        assertEquals(10, properties["used"])
        assertEquals("2026-10-09T00:00:00+09:00", properties["resetsAt"])
    }

    @Test
    fun anUnavailableUsageStoreIsA503InsteadOfAnUncountedSuccess() {
        Mockito.doThrow(PlanUsageStoreException()).`when`(guests).used("192.0.2.9", today)

        mvc().perform(get("/api/v1/plan-usage").with { it.remoteAddr = "192.0.2.9"; it })
            .andExpect(status().isServiceUnavailable)
            .andExpect(jsonPath("$.code").value("QUOTA_UNAVAILABLE"))
    }
}
