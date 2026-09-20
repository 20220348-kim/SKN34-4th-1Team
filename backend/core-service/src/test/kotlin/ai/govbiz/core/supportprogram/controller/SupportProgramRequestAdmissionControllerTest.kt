package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchReadinessResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchState
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceNotSupportedException
import ai.govbiz.core.supportprogram.service.readiness.SupportProgramSearchReadinessService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchPreviewService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import ai.govbiz.core.supportprogram.repository.SupportProgramSearchResultRepository
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.head
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class SupportProgramRequestAdmissionControllerTest {
    private val search = Mockito.mock(SupportProgramSearchService::class.java)
    private val readiness = Mockito.mock(SupportProgramSearchReadinessService::class.java)
    private val detail = Mockito.mock(SupportProgramDetailService::class.java)
    private val evidence = Mockito.mock(SupportProgramEvidenceService::class.java)
    private val now = AtomicLong()
    private val result = SupportProgramSearchResult("서울 AI", emptyList())

    private fun mvc(perClient: Int = 1, global: Int = 10, concurrent: Int = 2): MockMvc {
        val admission = SupportProgramRequestAdmissionService(
            SupportProgramRequestAdmissionProperties(perClient, global, concurrent),
            now::get,
        )
        return MockMvcBuilders.standaloneSetup(
            SupportProgramController(SupportProgramSearchPreviewService(search, Mockito.mock(SupportProgramSearchResultRepository::class.java)), readiness, detail, evidence, admission),
        ).setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver { Mockito.mock(AccountSessionService::class.java) })
            .setControllerAdvice(ApiExceptionHandler()).build()
    }

    private fun searchRequest(address: String = "192.0.2.1"): MockHttpServletRequestBuilder =
        get(SEARCH).param("query", "서울 AI").with { it.remoteAddr = address; it }

    private fun postSearchRequest(): MockHttpServletRequestBuilder = post(SEARCH)
        .contentType(MediaType.APPLICATION_JSON)
        .content("""{"query":"서울 AI"}""")
        .with { it.remoteAddr = "192.0.2.1"; it }

    private fun answerRequest(): MockHttpServletRequestBuilder = post(ANSWERS)
        .contentType(MediaType.APPLICATION_JSON)
        .content("""{"sourceCode":"BIZINFO","sourceProgramId":"PBLN_TEST","question":"신청 대상은?"}""")
        .with { it.remoteAddr = "192.0.2.1"; it }

    @Test
    fun searchAndEvidenceShareTheSameLimitAndRejectionsNeverCallTheDownstreamService() {
        val mvc = mvc()
        Mockito.`when`(search.search("서울 AI", true)).thenReturn(result)
        mvc.perform(searchRequest()).andExpect(status().isOk())
        mvc.perform(answerRequest())
            .andExpect(status().isTooManyRequests())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(header().string("Retry-After", "60"))
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.status").value(429))
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_RATE_LIMITED"))
            .andExpect(jsonPath("$.retryAfterSeconds").value(60))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:support-program-rate-limited"))
            .andExpect(jsonPath("$.instance").value(ANSWERS))
        Mockito.verifyNoInteractions(evidence)
        Mockito.verify(search, Mockito.times(1)).search("서울 AI", true)
    }

    @Test
    fun postSearchSharesTheSameQuotaWithGetSearchAndEvidence() {
        val mvc = mvc()
        Mockito.`when`(search.search("서울 AI", true)).thenReturn(result)
        mvc.perform(postSearchRequest()).andExpect(status().isOk())
        mvc.perform(searchRequest()).andExpect(status().isTooManyRequests())
        mvc.perform(answerRequest()).andExpect(status().isTooManyRequests())
        Mockito.verify(search, Mockito.times(1)).search("서울 AI", true)
        Mockito.verifyNoInteractions(evidence)
    }

    @Test
    fun getSearchCannotBypassTheQuotaByChangingToPost() {
        val mvc = mvc()
        Mockito.`when`(search.search("서울 AI", true)).thenReturn(result)
        mvc.perform(searchRequest()).andExpect(status().isOk())
        mvc.perform(postSearchRequest()).andExpect(status().isTooManyRequests())
        Mockito.verify(search, Mockito.times(1)).search("서울 AI", true)
    }

    @Test
    fun admittedEvidenceFailuresStillConsumeTheSharedRateQuota() {
        val mvc = mvc()
        Mockito.doThrow(SupportProgramEvidenceNotSupportedException())
            .`when`(evidence).answer("BIZINFO", "PBLN_TEST", "신청 대상은?")
        mvc.perform(answerRequest()).andExpect(status().isUnprocessableContent())
        mvc.perform(searchRequest()).andExpect(status().isTooManyRequests())
        Mockito.verifyNoInteractions(search)
    }

    @Test
    fun changingForwardedHeadersCannotBypassTheSocketAddressLimit() {
        val mvc = mvc()
        Mockito.`when`(search.search("서울 AI", true)).thenReturn(result)
        mvc.perform(searchRequest().header("X-Forwarded-For", "198.51.100.1"))
            .andExpect(status().isOk())
        mvc.perform(searchRequest().header("X-Forwarded-For", "198.51.100.2")
            .header("Forwarded", "for=198.51.100.3"))
            .andExpect(status().isTooManyRequests())
        mvc.perform(searchRequest("192.0.2.2")).andExpect(status().isOk())
    }

    @Test
    fun differentAddressesAreStillSubjectToTheGlobalCapAndRecoverAfterTheRollingWindow() {
        val mvc = mvc(perClient = 10, global = 1)
        Mockito.`when`(search.search("서울 AI", true)).thenReturn(result)
        mvc.perform(searchRequest()).andExpect(status().isOk())
        now.set(TimeUnit.MILLISECONDS.toNanos(1))
        mvc.perform(searchRequest("192.0.2.2"))
            .andExpect(status().isTooManyRequests())
            .andExpect(header().string("Retry-After", "60"))
        now.set(TimeUnit.SECONDS.toNanos(60))
        mvc.perform(searchRequest("192.0.2.2")).andExpect(status().isOk())
    }

    @Test
    fun invalidRequestsAndOptionsDoNotConsumeQuotaButImplicitHeadDoes() {
        val mvc = mvc()
        Mockito.`when`(search.search("서울 AI", true)).thenReturn(result)
        mvc.perform(get(SEARCH)).andExpect(status().isBadRequest())
        mvc.perform(get(SEARCH).param("query", "가".repeat(501))).andExpect(status().isBadRequest())
        mvc.perform(postSearchRequest().content("""{"query":" "}"""))
            .andExpect(status().isBadRequest())
        mvc.perform(post(ANSWERS).contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isBadRequest())
        mvc.perform(options(SEARCH)).andExpect(status().isOk())
        mvc.perform(head(SEARCH).param("query", "서울 AI").with { it.remoteAddr = "192.0.2.1"; it })
            .andExpect(status().isOk())
        mvc.perform(searchRequest()).andExpect(status().isTooManyRequests())
        Mockito.verify(search, Mockito.times(1)).search("서울 AI", true)
        Mockito.verifyNoInteractions(evidence)
    }

    @Test
    fun readinessAndDetailsRemainAccessibleWhenTheRequestQuotaIsExhausted() {
        val mvc = mvc()
        Mockito.`when`(search.search("서울 AI", true)).thenReturn(result)
        Mockito.`when`(readiness.get()).thenReturn(
            SupportProgramSearchReadinessResult(SupportProgramSearchState.PREPARING, 0, false, null, null, emptyList()),
        )
        Mockito.doThrow(ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException())
            .`when`(detail).get("BIZINFO", "PBLN_TEST")
        mvc.perform(searchRequest()).andExpect(status().isOk())
        mvc.perform(get("/api/v1/support-programs/readiness")).andExpect(status().isOk())
        mvc.perform(get("/api/v1/support-programs/detail").param("sourceCode", "BIZINFO")
            .param("sourceProgramId", "PBLN_TEST")).andExpect(status().isNotFound())
        Mockito.verify(readiness).get()
        Mockito.verify(detail).get("BIZINFO", "PBLN_TEST")
    }

    @Test
    fun simultaneousEvidenceIsRejectedAsBusyAndCanEnterWhenTheSearchFinishes() {
        val mvc = mvc(perClient = 10, concurrent = 1)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        Mockito.doAnswer {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            result
        }.`when`(search).search("서울 AI", true)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val first = executor.submit { mvc.perform(searchRequest()).andExpect(status().isOk()) }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            mvc.perform(answerRequest())
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_BUSY"))
                .andExpect(jsonPath("$.status").value(503))
                .andExpect(jsonPath("$.retryAfterSeconds").value(1))
                .andExpect(header().string("Retry-After", "1"))
                .andExpect(header().string("Cache-Control", "no-store"))
            Mockito.verifyNoInteractions(evidence)
            release.countDown()
            first.get(5, TimeUnit.SECONDS)
            Mockito.doThrow(SupportProgramEvidenceNotSupportedException())
                .`when`(evidence).answer("BIZINFO", "PBLN_TEST", "신청 대상은?")
            mvc.perform(answerRequest()).andExpect(status().isUnprocessableContent())
        } finally {
            release.countDown()
            executor.shutdownNow()
        }
    }

    companion object {
        private const val SEARCH = "/api/v1/support-programs/search"
        private const val ANSWERS = "/api/v1/support-programs/detail/answers"
    }
}
