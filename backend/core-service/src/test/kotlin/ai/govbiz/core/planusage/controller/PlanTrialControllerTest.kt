package ai.govbiz.core.planusage.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.planusage.PlanUsageTestHelper
import ai.govbiz.core.planusage.domain.AccountPlan
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanSource
import ai.govbiz.core.planusage.repository.GuestPlanUsageRepository
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.service.PlanUsageService
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class PlanTrialControllerTest {
    private val seoul = ZoneId.of("Asia/Seoul")
    private val clock = Clock.fixed(Instant.parse("2026-10-08T12:00:00Z"), seoul)
    private val repository = Mockito.mock(PlanUsageRepository::class.java)
    private val sessions = Mockito.mock(AccountSessionService::class.java)
    private val member = Account(7, "member@example.test", AccountRole.USER, LocalDateTime.of(2026, 9, 1, 9, 0), null, LocalDateTime.of(2026, 9, 1, 9, 0))

    private fun mvc(): MockMvc = MockMvcBuilders.standaloneSetup(
        PlanTrialController(
            PlanUsageService(
                repository, Mockito.mock(GuestPlanUsageRepository::class.java), clock, PlanUsageTestHelper.noTransactions(),
                Mockito.mock(AccountRepository::class.java), "",
            ),
        ),
    )
        .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver({ sessions }, { AccountTestHelper.cookieHelper() }))
        .setControllerAdvice(ApiExceptionHandler()).build()

    private fun start(plan: String) = post("/api/v1/plan-trials").header(HttpHeaders.AUTHORIZATION, "Bearer member-token")
        .contentType(MediaType.APPLICATION_JSON).content("""{"plan":"$plan"}""")

    @Test
    fun startingATrialReturnsTheNewPlanWithItsEndAndTheTrialsStillAvailable() {
        Mockito.doReturn(member).`when`(sessions).requireAccount("member-token")
        val now = ZonedDateTime.now(clock)
        Mockito.doReturn(AccountPlan.FREE, AccountPlan(PlanCode.PLUS, now, now.plusDays(14), source = PlanSource.TRIAL))
            .`when`(repository).findPlan(7)
        Mockito.doReturn(emptySet<PlanCode>(), setOf(PlanCode.PLUS)).`when`(repository).findTrialPlans(7)

        mvc().perform(start("PLUS"))
            .andExpect(status().isCreated)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.plan").value("PLUS"))
            .andExpect(jsonPath("$.planSource").value("TRIAL"))
            .andExpect(jsonPath("$.planEndsAt").value("2026-10-22T21:00:00+09:00"))
            .andExpect(jsonPath("$.trialsAvailable[0]").value("PREMIUM"))
            .andExpect(jsonPath("$.items[0].period").value("PLAN"))
            .andExpect(jsonPath("$.items[0].limit").value(500))
    }

    @Test
    fun aUsedTrialIsAConflictAndAFreePlanIsNotATrialToStart() {
        Mockito.doReturn(member).`when`(sessions).requireAccount("member-token")
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(setOf(PlanCode.PLUS)).`when`(repository).findTrialPlans(7)

        mvc().perform(start("PLUS"))
            .andExpect(status().isConflict)
            .andExpect(jsonPath("$.code").value("PLAN_TRIAL_USED"))
        mvc().perform(start("FREE")).andExpect(status().isBadRequest)
        mvc().perform(start("plus")).andExpect(status().isBadRequest)
    }

    @Test
    fun aMemberWithoutAVerifiedEmailCannotStartATrial() {
        Mockito.doReturn(member.copy(emailVerifiedAt = null)).`when`(sessions).requireAccount("member-token")

        mvc().perform(start("PREMIUM"))
            .andExpect(status().isForbidden)
            .andExpect(jsonPath("$.code").value("PLAN_TRIAL_EMAIL_UNVERIFIED"))
    }
}
