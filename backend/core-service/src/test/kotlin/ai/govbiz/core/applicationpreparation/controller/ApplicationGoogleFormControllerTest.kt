package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationOnlineFormMcpException
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleForm
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleFormQuestion
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleFormQuestionKind
import ai.govbiz.core.applicationpreparation.service.ApplicationGoogleFormService
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class ApplicationGoogleFormControllerTest {
    @Mock private lateinit var service: ApplicationGoogleFormService
    @Mock private lateinit var sessions: AccountSessionService
    private lateinit var mvc: MockMvc
    private val session = Cookie(SessionCookieHelper.COOKIE_NAME, "session-token")
    private val account = AccountTestHelper.account()

    @BeforeEach
    fun setUp() {
        mvc = MockMvcBuilders.standaloneSetup(ApplicationGoogleFormController(service))
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessions, AccountTestHelper.cookieHelper()))
            .setControllerAdvice(ApiExceptionHandler())
            .build()
    }

    @Test fun returnsEntriesAndExactOptionsWithoutCaching() {
        doReturn(account).`when`(sessions).requireAccount("session-token")
        doReturn(ApplicationGoogleForm("https://docs.google.com/forms/d/e/public-id/viewform", "특강 신청", listOf(
            ApplicationGoogleFormQuestion("101", "참석 일정", "", true, ApplicationGoogleFormQuestionKind.MULTI_CHOICE,
                listOf("09.17  [TIPS]"), true),
            ApplicationGoogleFormQuestion(null, "사업자등록증", "", false, ApplicationGoogleFormQuestionKind.UNSUPPORTED, emptyList(), false),
        ))).`when`(service).read(account, "KSTARTUP", "179183")
        mvc.perform(get(PATH).param("sourceCode", "KSTARTUP").param("sourceProgramId", "179183").cookie(session))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.responderUrl").value("https://docs.google.com/forms/d/e/public-id/viewform"))
            .andExpect(jsonPath("$.questions[0].entryId").value("101"))
            .andExpect(jsonPath("$.questions[0].kind").value("MULTI_CHOICE"))
            .andExpect(jsonPath("$.questions[0].options[0]").value("09.17  [TIPS]"))
            .andExpect(jsonPath("$.questions[0].allowsOther").value(true))
            .andExpect(jsonPath("$.questions[1].entryId").isEmpty())
            .andExpect(jsonPath("$.questions[1].kind").value("UNSUPPORTED"))
    }

    @Test fun signInOnlyFormIsUnprocessableAndReaderOutageIsTemporary() {
        doReturn(account).`when`(sessions).requireAccount("session-token")
        doThrow(ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_LOGIN_REQUIRED")).`when`(service).read(account, "KSTARTUP", "1")
        doThrow(ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_SOURCE_UNAVAILABLE")).`when`(service).read(account, "KSTARTUP", "2")
        mvc.perform(get(PATH).param("sourceCode", "KSTARTUP").param("sourceProgramId", "1").cookie(session))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("APPLICATION_ONLINE_FORM_LOGIN_REQUIRED"))
        mvc.perform(get(PATH).param("sourceCode", "KSTARTUP").param("sourceProgramId", "2").cookie(session))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("APPLICATION_ONLINE_FORM_SOURCE_UNAVAILABLE"))
    }

    @Test fun requiresASession() {
        doThrow(AuthenticationRequiredException()).`when`(sessions).requireAccount(null)
        mvc.perform(get(PATH).param("sourceCode", "KSTARTUP").param("sourceProgramId", "1"))
            .andExpect(status().isUnauthorized())
    }

    private companion object {
        const val PATH = "/api/v1/application-preparations/google-form"
    }
}
