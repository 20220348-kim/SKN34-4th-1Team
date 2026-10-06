package ai.govbiz.core.combinationreview.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.account.web.SessionOriginInterceptor
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewDeleteConflictException
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewNotFoundException
import ai.govbiz.core.combinationreview.service.CombinationReviewService
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class CombinationReviewControllerTest {
    private val service = mock(CombinationReviewService::class.java)
    private val sessions = mock(AccountSessionService::class.java)
    private val account = AccountTestHelper.account()
    private val cookie = Cookie(SessionCookieHelper.COOKIE_NAME, "session-token")
    private lateinit var mvc: MockMvc

    @BeforeEach
    fun setUp() {
        doReturn(account).`when`(sessions).requireAccount("session-token")
        mvc = MockMvcBuilders.standaloneSetup(CombinationReviewController(service))
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessions))
            .addInterceptors(SessionOriginInterceptor(listOf("http://localhost:5173")))
            .setControllerAdvice(ApiExceptionHandler()).build()
    }

    @Test
    fun rejectsDeletionWithAStableConflictContract() {
        doThrow(CombinationReviewDeleteConflictException()).`when`(service).deleteOwned(account, 2)
        request().andExpect(status().isConflict())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.code").value("COMBINATION_REVIEW_DELETE_CONFLICT"))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:combination-review-delete-conflict"))
        verify(service).deleteOwned(account, 2)
    }

    @Test
    fun preservesNotFoundAndSuccessfulEmptyDeletionContracts() {
        doThrow(CombinationReviewNotFoundException()).`when`(service).deleteOwned(account, 2)
        request().andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("COMBINATION_REVIEW_NOT_FOUND"))
        mvc.perform(delete("/api/v1/combination-reviews/3").cookie(cookie).header(HttpHeaders.ORIGIN, "http://localhost:5173"))
            .andExpect(status().isNoContent()).andExpect(content().string(""))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
        verify(service).deleteOwned(account, 3)
    }

    private fun request() = mvc.perform(delete("/api/v1/combination-reviews/2").cookie(cookie)
        .header(HttpHeaders.ORIGIN, "http://localhost:5173"))
}
