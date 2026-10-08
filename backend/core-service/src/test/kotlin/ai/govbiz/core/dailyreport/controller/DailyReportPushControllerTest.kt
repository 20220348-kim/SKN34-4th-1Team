package ai.govbiz.core.dailyreport.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.dailyreport.service.DailyReportPushService
import ai.govbiz.core.dailyreport.service.dto.DailyReportPushSettingsResult
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class DailyReportPushControllerTest {
    private val service = mock(DailyReportPushService::class.java)
    private val sessions = mock(AccountSessionService::class.java)
    private val account = AccountTestHelper.account()
    private val id = "a4a15267-866c-4df0-bb91-55d7c14d7a72"
    private val mvc = MockMvcBuilders.standaloneSetup(DailyReportPushController(service))
        .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessions, AccountTestHelper.cookieHelper()))
        .setControllerAdvice(ApiExceptionHandler()).build()

    @Test
    fun authenticatedSettingsExposeOnlyStateAndMutationsUseBearerIdentity() {
        doReturn(account).`when`(sessions).requireAccount("session-token")
        doReturn(DailyReportPushSettingsResult(true, true, 8, true)).`when`(service).settings(account, id)
        mvc.perform(get("/api/v1/me/daily-reports/push").param("deviceId", id).header("Authorization", "Bearer session-token"))
            .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.enabled").value(true)).andExpect(jsonPath("$.token").doesNotExist())
        mvc.perform(put("/api/v1/me/daily-reports/push").header("Authorization", "Bearer session-token")
            .contentType(MediaType.APPLICATION_JSON).content("""{"deviceId":"$id","token":"ExpoPushToken[test]"}"""))
            .andExpect(status().isNoContent())
        verify(service).register(account, id, "ExpoPushToken[test]", "session-token")
    }

    @Test
    fun unauthenticatedAndMalformedRequestsNeverReachRegistration() {
        doThrow(AuthenticationRequiredException()).`when`(sessions).requireAccount(null)
        mvc.perform(get("/api/v1/me/daily-reports/push").param("deviceId", id)).andExpect(status().isUnauthorized())
        doReturn(account).`when`(sessions).requireAccount("session-token")
        mvc.perform(put("/api/v1/me/daily-reports/push").header("Authorization", "Bearer session-token")
            .contentType(MediaType.APPLICATION_JSON).content("""{"deviceId":"$id","token":"not-a-push-token"}"""))
            .andExpect(status().isBadRequest())
        verifyNoInteractions(service)
    }
}
