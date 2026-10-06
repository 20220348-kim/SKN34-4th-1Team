package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.service.ApplicationFormDiscoveryService
import ai.govbiz.core.applicationpreparation.service.ApplicationPreparationService
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class ApplicationPreparationDeletionControllerTest {
    @Test
    fun activeDocumentJobReturnsTheExisting409ProblemContract() {
        val service = mock(ApplicationPreparationService::class.java)
        val sessions = mock(AccountSessionService::class.java)
        val account = AccountTestHelper.account()
        doReturn(account).`when`(sessions).requireAccount("session-token")
        doThrow(ApplicationPreparationRunConflictException()).`when`(service).deleteOwned(account, 7)
        val mvc = MockMvcBuilders.standaloneSetup(ApplicationPreparationController(service, mock(ApplicationFormDiscoveryService::class.java), false))
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessions))
            .setControllerAdvice(ApiExceptionHandler())
            .build()

        mvc.perform(delete("/api/v1/application-preparations/7").cookie(Cookie(SessionCookieHelper.COOKIE_NAME, "session-token")))
            .andExpect(status().isConflict())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.code").value("APPLICATION_PREPARATION_RUN_CONFLICT"))
        verify(service).deleteOwned(account, 7)
    }
}
