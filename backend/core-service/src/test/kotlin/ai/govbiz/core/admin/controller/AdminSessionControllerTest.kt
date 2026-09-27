package ai.govbiz.core.admin.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AccountSuspendedException
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.admin.web.AdminPrincipalArgumentResolver
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class AdminSessionControllerTest {
    @Mock private lateinit var sessions: AccountSessionService
    private lateinit var mvc: MockMvc

    @BeforeEach
    fun setUp() {
        mvc = MockMvcBuilders.standaloneSetup(AdminSessionController())
            .setCustomArgumentResolvers(AdminPrincipalArgumentResolver { sessions })
            .setControllerAdvice(ApiExceptionHandler()).build()
    }

    @Test
    fun returnsStableIdentityForAdminWithoutSessionSecrets() {
        val account = AccountTestHelper.account().copy(role = AccountRole.ADMIN)
        doReturn(account).`when`(sessions).requireAccount("valid-session")
        mvc.perform(get(PATH).cookie(Cookie(SessionCookieHelper.COOKIE_NAME, "valid-session")))
            .andExpect(status().isOk())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.accountId").value(account.id))
            .andExpect(jsonPath("$.email").value(account.email))
            .andExpect(jsonPath("$.role").value("ADMIN"))
            .andExpect(jsonPath("$.sessionToken").doesNotExist())
    }

    @Test
    fun rejectsAnonymousExpiredSuspendedAndNonAdminSessions() {
        doThrow(AuthenticationRequiredException()).`when`(sessions).requireAccount(null)
        doThrow(AuthenticationRequiredException()).`when`(sessions).requireAccount("expired")
        doThrow(AccountSuspendedException()).`when`(sessions).requireAccount("suspended")
        doReturn(AccountTestHelper.account().copy(role = AccountRole.USER)).`when`(sessions).requireAccount("member")
        mvc.perform(get(PATH)).andExpect(status().isUnauthorized())
        for ((token, expected) in listOf("expired" to 401, "suspended" to 403, "member" to 403)) {
            mvc.perform(get(PATH).cookie(Cookie(SessionCookieHelper.COOKIE_NAME, token)))
                .andExpect(status().`is`(expected))
        }
    }

    companion object { private const val PATH = "/api/v1/admin/session" }
}
