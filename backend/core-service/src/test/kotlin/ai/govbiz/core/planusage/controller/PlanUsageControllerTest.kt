package ai.govbiz.core.planusage.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.service.PlanUsageService
import java.time.LocalDateTime
import org.hamcrest.Matchers.nullValue
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class PlanUsageControllerTest {
    private val repository = Mockito.mock(PlanUsageRepository::class.java)
    private val sessions = Mockito.mock(AccountSessionService::class.java)
    private val member = Account(7, "member@example.test", AccountRole.USER, null, null, LocalDateTime.of(2026, 9, 1, 9, 0))

    private fun mvc(): MockMvc = MockMvcBuilders.standaloneSetup(PlanUsageController(PlanUsageService(repository)))
        .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver({ sessions }, { AccountTestHelper.cookieHelper() }))
        .setControllerAdvice(ApiExceptionHandler()).build()

    @Test
    fun guestsHaveNoPlanAndTheStoreIsNotRead() {
        mvc().perform(get("/api/v1/plan-usage"))
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.plan").value(nullValue()))
            .andExpect(jsonPath("$.items").doesNotExist())

        Mockito.verifyNoInteractions(repository)
    }

    @Test
    fun membersSeeTheirAssignedPlan() {
        Mockito.doReturn(member).`when`(sessions).requireAccount("member-token")
        Mockito.doReturn(PlanCode.PREMIUM).`when`(repository).findPlan(7)

        mvc().perform(get("/api/v1/plan-usage").header(HttpHeaders.AUTHORIZATION, "Bearer member-token"))
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.plan").value("PREMIUM"))
    }
}
