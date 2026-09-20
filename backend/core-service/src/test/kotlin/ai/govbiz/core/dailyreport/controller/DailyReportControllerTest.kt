package ai.govbiz.core.dailyreport.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.account.web.SessionOriginInterceptor
import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import ai.govbiz.core.dailyreport.service.DailyReportService
import ai.govbiz.core.dailyreport.service.DailyReportSubscriptionService
import ai.govbiz.core.dailyreport.service.dto.DailyReportSettingsResult
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import jakarta.servlet.http.Cookie
import java.time.LocalDate
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class DailyReportControllerTest {
    private val reports = mock(DailyReportService::class.java)
    private val subscriptions = mock(DailyReportSubscriptionService::class.java)
    private val sessions = mock(AccountSessionService::class.java)
    private val account = AccountTestHelper.account()
    private lateinit var mvc: MockMvc
    private val cookie = Cookie(SessionCookieHelper.COOKIE_NAME, "session-token")

    @BeforeEach
    fun setUp() {
        val admission = SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties())
        mvc = MockMvcBuilders.standaloneSetup(DailyReportController(reports, subscriptions, admission), DailyReportEmailController(subscriptions, admission))
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessions))
            .addInterceptors(SessionOriginInterceptor(listOf("http://localhost:5173")))
            .setControllerAdvice(DailyReportExceptionHandler(), ApiExceptionHandler()).build()
    }

    @Test
    fun privateSettingsRequireAuthentication() {
        doThrow(AuthenticationRequiredException()).`when`(sessions).requireAccount(null)
        mvc.perform(get("/api/v1/me/daily-reports/settings")).andExpect(status().isUnauthorized())
        verifyNoInteractions(subscriptions)
    }

    @Test
    fun settingsAreOwnerScopedAndHaveNoStoreAndSchedulerState() {
        authenticated()
        doReturn(DailyReportSettingsResult("AI", false, false, false, 8, false)).`when`(subscriptions).settings(account)
        mvc.perform(get("/api/v1/me/daily-reports/settings").cookie(cookie))
            .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.supportPurpose").value("AI")).andExpect(jsonPath("$.schedulerEnabled").value(false))
            .andExpect(jsonPath("$.emailConfirmed").value(false))
        verify(subscriptions).settings(account)
    }

    @Test
    fun purpose101AndControlCharactersAreRejectedBeforeCallingService() {
        authenticated()
        for (purpose in listOf("가".repeat(101), "bad\\u0000value")) {
            mvc.perform(put("/api/v1/me/daily-reports/settings").cookie(cookie).header("Origin", "http://localhost:5173")
                .contentType(MediaType.APPLICATION_JSON).content("""{"supportPurpose":"$purpose","enabled":false,"consent":false}"""))
                .andExpect(status().isBadRequest())
        }
        verifyNoInteractions(subscriptions)
    }

    @Test
    fun cookieMutationFromAnotherOriginIsRejected() {
        mvc.perform(post("/api/v1/me/daily-reports/preview").cookie(cookie).header("Origin", "https://attacker.example"))
            .andExpect(status().isForbidden())
        verifyNoInteractions(reports)
    }

    @Test
    fun latestResponseDoesNotExposeInternalOwnershipTokensOrGenerationKey() {
        authenticated()
        val report = DailyReport(1, account.id, LocalDate.of(2026, 9, 6), DailyReportStatus.READY, DailyReportDeliveryStatus.NOT_REQUESTED,
            DailyReportInput("서울기업", "서울", "정보통신업", "AI"), DailyReportContent(emptyList(), listOf("선정확률 아님")),
            AccountTestHelper.NOW, null, 1, "internal-key", AccountTestHelper.NOW)
        doReturn(report).`when`(reports).latest(account)
        mvc.perform(get("/api/v1/me/daily-reports/latest").cookie(cookie)).andExpect(status().isOk())
            .andExpect(jsonPath("$.report.generatedAt").value("2026-09-06T12:00:00+09:00"))
            .andExpect(jsonPath("$.report.companyName").value("서울기업"))
            .andExpect(jsonPath("$.report.accountId").doesNotExist()).andExpect(jsonPath("$.report.generationKey").doesNotExist())
    }

    @Test
    fun publicEmailLinksNeedExplicitPostAndInvalidTokenHasStableError() {
        val token = "A".repeat(43)
        mvc.perform(get("/api/v1/daily-reports/email/confirm").param("token", token)).andExpect(status().isMethodNotAllowed())
        verifyNoInteractions(subscriptions)
        doThrow(DailyReportException(DailyReportErrorCode.INVALID_EMAIL_TOKEN)).`when`(subscriptions).confirm(token)
        mvc.perform(post("/api/v1/daily-reports/email/confirm").contentType(MediaType.APPLICATION_JSON).content("""{"token":"$token"}"""))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_EMAIL_TOKEN"))
            .andExpect(header().string("Cache-Control", "no-store"))
    }

    private fun authenticated() { doReturn(account).`when`(sessions).requireAccount("session-token") }
}
