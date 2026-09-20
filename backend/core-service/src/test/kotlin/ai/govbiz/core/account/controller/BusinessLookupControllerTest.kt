package ai.govbiz.core.account.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness
import ai.govbiz.core.account.client.bizno.exception.BiznoClientException
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.BusinessLookupService
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.service.exception.BusinessNotFoundException
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class BusinessLookupControllerTest {

    @Mock
    private lateinit var lookupService: BusinessLookupService

    @Mock
    private lateinit var sessionService: AccountSessionService

    private lateinit var mockMvc: MockMvc

    private val session = Cookie(SessionCookieHelper.COOKIE_NAME, "session-token")

    @BeforeEach
    fun setUp() {
        mockMvc = MockMvcBuilders
            .standaloneSetup(BusinessLookupController(lookupService))
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessionService))
            .setControllerAdvice(ApiExceptionHandler())
            .build()
    }

    @Test
    fun returnsTheCompanyNameAndStatusForARegisteredNumber() {
        doReturn(AccountTestHelper.account()).`when`(sessionService).requireAccount("session-token")
        doReturn(BiznoBusiness("1248100998", "삼성전자(주)", "계속사업자", "01")).`when`(lookupService).lookup("124-81-00998")

        mockMvc.perform(get(LOOKUP_PATH).param("businessNumber", "124-81-00998").cookie(session))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.businessNumber").value("1248100998"))
            .andExpect(jsonPath("$.companyName").value("삼성전자(주)"))
            .andExpect(jsonPath("$.businessStatus").value("계속사업자"))
            .andExpect(jsonPath("$.isActive").value(true))
    }

    @Test
    fun requiresASessionAndAWellFormedNumberBeforeCallingTheService() {
        doThrow(AuthenticationRequiredException()).`when`(sessionService).requireAccount(null)
        mockMvc.perform(get(LOOKUP_PATH).param("businessNumber", "1248100998"))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"))

        doReturn(AccountTestHelper.account()).`when`(sessionService).requireAccount("session-token")
        mockMvc.perform(get(LOOKUP_PATH).param("businessNumber", "12-34").cookie(session))
            .andExpect(status().isBadRequest())
        mockMvc.perform(get(LOOKUP_PATH).cookie(session))
            .andExpect(status().isBadRequest())

        verifyNoInteractions(lookupService)
    }

    @Test
    fun mapsAnUnregisteredNumberAndBiznoFailuresToStableProblems() {
        doReturn(AccountTestHelper.account()).`when`(sessionService).requireAccount("session-token")
        doThrow(BusinessNotFoundException()).`when`(lookupService).lookup("1234567890")
        doThrow(BiznoClientException.notConfigured()).`when`(lookupService).lookup("9999999999")
        doThrow(BiznoClientException.timeout(null)).`when`(lookupService).lookup("8888888888")

        mockMvc.perform(get(LOOKUP_PATH).param("businessNumber", "1234567890").cookie(session))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("BUSINESS_NOT_FOUND"))
        mockMvc.perform(get(LOOKUP_PATH).param("businessNumber", "9999999999").cookie(session))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("BIZNO_NOT_CONFIGURED"))
        mockMvc.perform(get(LOOKUP_PATH).param("businessNumber", "8888888888").cookie(session))
            .andExpect(status().isGatewayTimeout())
            .andExpect(jsonPath("$.code").value("BIZNO_TIMEOUT"))
    }

    private companion object {
        const val LOOKUP_PATH = "/api/v1/me/company/lookup"
    }
}
