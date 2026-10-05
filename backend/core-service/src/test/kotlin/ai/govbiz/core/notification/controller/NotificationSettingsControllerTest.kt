package ai.govbiz.core.notification.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.account.web.SessionOriginInterceptor
import ai.govbiz.core.notification.domain.DeadlineReminderSetting
import ai.govbiz.core.notification.domain.exception.NotificationSettingsErrorCode
import ai.govbiz.core.notification.domain.exception.NotificationSettingsException
import ai.govbiz.core.notification.service.NotificationSettingsService
import ai.govbiz.core.notification.service.dto.NotificationSettingsResult
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class NotificationSettingsControllerTest {
    private val service = mock(NotificationSettingsService::class.java)
    private val sessions = mock(AccountSessionService::class.java)
    private val account = AccountTestHelper.account()
    private val cookie = Cookie(SessionCookieHelper.COOKIE_NAME, "session-token")
    private val emailOn = DeadlineReminderSetting(enabled = true, daysBefore = 3, email = true, push = false)
    private lateinit var mvc: MockMvc

    @BeforeEach
    fun setUp() {
        mvc = MockMvcBuilders.standaloneSetup(NotificationSettingsController(service))
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessions))
            .addInterceptors(SessionOriginInterceptor(listOf("http://localhost:5173")))
            .setControllerAdvice(NotificationSettingsExceptionHandler(), ApiExceptionHandler()).build()
    }

    @Test
    fun settingsRequireAuthenticationAndAreNeverCached() {
        doThrow(AuthenticationRequiredException()).`when`(sessions).requireAccount(null)
        mvc.perform(get("/api/v1/me/notification-settings")).andExpect(status().isUnauthorized())
        verifyNoInteractions(service)

        doReturn(account).`when`(sessions).requireAccount("session-token")
        doReturn(result(DeadlineReminderSetting.DEFAULT)).`when`(service).settings(account)
        mvc.perform(get("/api/v1/me/notification-settings").cookie(cookie))
            .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.deadlineReminder.enabled").value(false))
            .andExpect(jsonPath("$.deadlineReminder.daysBefore").value(3))
            .andExpect(jsonPath("$.emailConfirmed").value(true))
            .andExpect(jsonPath("$.pushDeviceRegistered").value(false))
            .andExpect(jsonPath("$.schedulerEnabled").value(false))
            .andExpect(jsonPath("$.sendHour").value(9))
            .andExpect(jsonPath("$.email").doesNotExist())
    }

    @Test
    fun cookieUpdateFromAnotherOriginIsRejectedBeforeTheService() {
        mvc.perform(put("/api/v1/me/notification-settings").cookie(cookie).header("Origin", "https://attacker.example")
            .contentType(MediaType.APPLICATION_JSON).content(body(true, 3, true, false)))
            .andExpect(status().isForbidden())
        verifyNoInteractions(service, sessions)
    }

    @Test
    fun allowedOriginCookieAndNativeBearerUpdatesSaveTheOwnersSetting() {
        doReturn(account).`when`(sessions).requireAccount("session-token")
        doReturn(result(emailOn)).`when`(service).updateDeadlineReminder(account, emailOn)
        mvc.perform(put("/api/v1/me/notification-settings").cookie(cookie).header("Origin", "http://localhost:5173")
            .contentType(MediaType.APPLICATION_JSON).content(body(true, 3, true, false)))
            .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.deadlineReminder.email").value(true))
        mvc.perform(put("/api/v1/me/notification-settings").header("Authorization", "Bearer session-token")
            .contentType(MediaType.APPLICATION_JSON).content(body(true, 3, true, false)))
            .andExpect(status().isOk())
        verify(service, org.mockito.Mockito.times(2)).updateDeadlineReminder(account, emailOn)
    }

    @Test
    fun outOfRangeDaysOrEnabledWithoutChannelAreRejectedBeforeTheService() {
        doReturn(account).`when`(sessions).requireAccount("session-token")
        for (request in listOf(body(true, 0, true, false), body(false, 8, false, false), body(true, 3, false, false),
            """{"deadlineReminder":{"enabled":true,"daysBefore":3}}""", """{}""")) {
            mvc.perform(put("/api/v1/me/notification-settings").cookie(cookie).header("Origin", "http://localhost:5173")
                .contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isBadRequest())
        }
        verifyNoInteractions(service)
    }

    @Test
    fun channelThatCannotDeliverReturnsAStableCodeWithoutDeliveryDetails() {
        doReturn(account).`when`(sessions).requireAccount("session-token")
        doThrow(NotificationSettingsException(NotificationSettingsErrorCode.EMAIL_CONFIRMATION_REQUIRED)).`when`(service)
            .updateDeadlineReminder(account, emailOn)
        mvc.perform(put("/api/v1/me/notification-settings").cookie(cookie).header("Origin", "http://localhost:5173")
            .contentType(MediaType.APPLICATION_JSON).content(body(true, 3, true, false)))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("EMAIL_CONFIRMATION_REQUIRED"))
            .andExpect(header().string("Cache-Control", "no-store"))
        val pushOn = DeadlineReminderSetting(enabled = true, daysBefore = 3, email = false, push = true)
        doThrow(NotificationSettingsException(NotificationSettingsErrorCode.PUSH_DELIVERY_UNAVAILABLE)).`when`(service)
            .updateDeadlineReminder(account, pushOn)
        mvc.perform(put("/api/v1/me/notification-settings").cookie(cookie).header("Origin", "http://localhost:5173")
            .contentType(MediaType.APPLICATION_JSON).content(body(true, 3, false, true)))
            .andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("PUSH_DELIVERY_UNAVAILABLE"))
    }

    private fun body(enabled: Boolean, daysBefore: Int, email: Boolean, push: Boolean) =
        """{"deadlineReminder":{"enabled":$enabled,"daysBefore":$daysBefore,"email":$email,"push":$push}}"""

    private fun result(setting: DeadlineReminderSetting) = NotificationSettingsResult(
        deadlineReminder = setting, emailConfirmed = true, emailDeliveryAvailable = true, pushDeliveryAvailable = true,
        pushDeviceRegistered = false, schedulerEnabled = false, sendHour = 9,
    )
}
