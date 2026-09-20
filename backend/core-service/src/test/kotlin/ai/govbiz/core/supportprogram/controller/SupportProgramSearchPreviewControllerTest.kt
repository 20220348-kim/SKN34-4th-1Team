package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core._common.config.JsonDeserializationConfig
import ai.govbiz.core._common.test.RedisTestConnection
import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.account.web.SessionOriginInterceptor
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.repository.SupportProgramSearchResultRepository
import ai.govbiz.core.supportprogram.repository.exception.SupportProgramSearchResultStoreException
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchResult
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.readiness.SupportProgramSearchReadinessService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchPreviewService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import jakarta.servlet.http.Cookie
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.security.MessageDigest
import java.util.UUID
import org.hamcrest.Matchers.nullValue
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mockito
import org.springframework.http.MediaType
import org.springframework.http.ProblemDetail
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import org.springframework.http.converter.json.ProblemDetailJacksonMixin
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class SupportProgramSearchPreviewControllerTest {
    private val search = Mockito.mock(SupportProgramSearchService::class.java)
    private val sessions = Mockito.mock(AccountSessionService::class.java)
    private val clock = MutableClock(Instant.parse("2026-09-10T03:00:00Z"))
    private val connection = RedisTestConnection()
    private val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build())
        .addMixIn(ProblemDetail::class.java, ProblemDetailJacksonMixin::class.java).also {
        JsonDeserializationConfig().strictJsonRequestTypes().customize(it)
    }.build()
    private val repository = SupportProgramSearchResultRepository(connection.redis, mapper)
    private val preview = SupportProgramSearchPreviewService(search, repository)
    private val validator = LocalValidatorFactoryBean().apply {
        setConfigurationInitializer { it.clockProvider { clock } }
        afterPropertiesSet()
    }
    private val conditions = SupportProgramCompanyConditions("대구", "무역", LocalDate.parse("2020-01-02"), "수출")
    private val programs = (1..5).map { index -> SupportProgram(
        id = "program-$index", sourceCode = "BIZINFO", title = "공고 고유표제 $index", organization = "기관 $index",
        summary = "공고 고유본문 $index", categories = listOf("수출"), regions = listOf("대구"), targetDescription = "중소기업",
        applicationPeriod = "상시 접수", applicationStartDate = null, applicationEndDate = null,
        status = SupportProgramStatus.OPEN, sourceName = "기업마당", sourceUrl = "https://example.invalid/program-$index",
        matchedReasons = listOf("공고 고유근거 $index"), recommendationScore = 100 - index,
    ) }

    init {
        Mockito.doAnswer { call ->
            val id = when (call.getArgument<String?>(0)) {
                "member-one" -> 1L
                "member-two" -> 2L
                else -> throw AuthenticationRequiredException()
            }
            Account(id, "member$id@example.invalid", AccountRole.USER, null, null, LocalDateTime.parse("2026-01-01T00:00:00"))
        }.`when`(sessions).requireAccount(Mockito.nullable(String::class.java))
    }

    @AfterEach
    fun closeValidator() { validator.close(); connection.close() }

    private fun mvc(perClient: Int = 100, previewService: SupportProgramSearchPreviewService = preview): MockMvc = MockMvcBuilders.standaloneSetup(
        SupportProgramController(
            previewService, Mockito.mock(SupportProgramSearchReadinessService::class.java),
            Mockito.mock(SupportProgramDetailService::class.java), Mockito.mock(SupportProgramEvidenceService::class.java),
            SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties(perClient, 100, 4)) { 0L },
        ),
    ).setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessions))
        .addInterceptors(SessionOriginInterceptor(listOf(ORIGIN)))
        .setControllerAdvice(ApiExceptionHandler()).setValidator(validator)
        .setMessageConverters(JacksonJsonHttpMessageConverter(mapper)).build()

    private fun postSearch() = post(PATH).contentType(MediaType.APPLICATION_JSON).content("""
        {"query":"  무역 지원  ","acceptingOnly":false,"companyConditions":{
          "region":" 대구 ","industry":" 무역 ","establishedOn":"2020-01-02","supportPurpose":" 수출 "}}
    """.trimIndent())

    private fun restore(token: String) = post("$PATH/results").contentType(MediaType.APPLICATION_JSON)
        .content(mapper.writeValueAsString(mapOf("resultToken" to token)))

    private fun MockHttpServletRequestBuilder.member(token: String = "member-one") =
        cookie(Cookie("govbiz_session", token)).header("Origin", ORIGIN)

    private fun stubPost() {
        Mockito.`when`(search.search("  무역 지원  ", false, conditions)).thenReturn(SupportProgramSearchResult("무역 지원", programs))
    }

    @ParameterizedTest
    @ValueSource(booleans = [false, true])
    fun guestHttpResponseContainsOnlyTwoProgramsAndNeverSerializesHiddenDetails(usePost: Boolean) {
        val request = if (usePost) {
            stubPost(); postSearch()
        } else {
            Mockito.`when`(search.search("무역 지원", true, null)).thenReturn(SupportProgramSearchResult("무역 지원", programs))
            get(PATH).queryParam("query", "무역 지원")
        }
        val body = mvc().perform(request).andExpect(status().isOk())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.programs.length()").value(2)).andExpect(jsonPath("$.totalCount").value(5))
            .andExpect(jsonPath("$.expiresAt").isString())
            .andExpect(jsonPath("$.context").doesNotExist()).andReturn().response.contentAsString
        val token = mapper.readTree(body).get("resultToken").asText()
        assertTrue(Duration.between(Instant.now(), Instant.parse(mapper.readTree(body).get("expiresAt").asText())).seconds in 1790..1800)
        assertEquals(token, UUID.fromString(token).toString())
        for (hidden in programs.drop(2)) {
            for (value in listOf(hidden.id, hidden.title, hidden.summary, hidden.sourceUrl) + hidden.matchedReasons) {
                assertFalse(body.contains(value), "A hidden program field must not enter the guest response: $value")
            }
        }
        Mockito.verifyNoInteractions(sessions)
    }

    @ParameterizedTest
    @ValueSource(booleans = [false, true])
    fun ordinaryLoggedInMembersReceiveAllFiveForBothSearchMethods(usePost: Boolean) {
        val request = if (usePost) {
            stubPost(); postSearch()
        } else {
            Mockito.`when`(search.search("", false, null)).thenReturn(SupportProgramSearchResult("", programs))
            get(PATH).queryParam("query", "").queryParam("acceptingOnly", "false")
        }
        mvc().perform(request.member()).andExpect(status().isOk())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.programs.length()").value(5)).andExpect(jsonPath("$.totalCount").value(5))
            .andExpect(jsonPath("$.resultToken").value(nullValue())).andExpect(jsonPath("$.expiresAt").value(nullValue()))
    }

    @Test
    fun loginRestoresIdenticalResultsAndNormalizedContextWithoutSearchOrAdmissionUsage() {
        stubPost()
        val mvc = mvc(perClient = 1)
        val guest = mapper.readTree(mvc.perform(postSearch()).andExpect(status().isOk()).andReturn().response.contentAsString)
        val token = guest.get("resultToken").asText()
        mvc.perform(restore(token)).andExpect(status().isUnauthorized()).andExpect(header().string("Cache-Control", "no-store"))
        val restored = mvc.perform(restore(token).member()).andExpect(status().isOk())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.query").value("무역 지원"))
            .andExpect(jsonPath("$.programs.length()").value(5)).andExpect(jsonPath("$.totalCount").value(5))
            .andExpect(jsonPath("$.resultToken").value(nullValue())).andExpect(jsonPath("$.expiresAt").value(nullValue()))
            .andExpect(jsonPath("$.context.query").value("무역 지원"))
            .andExpect(jsonPath("$.context.acceptingOnly").value(false))
            .andExpect(jsonPath("$.context.companyConditions.region").value("대구"))
            .andExpect(jsonPath("$.context.companyConditions.industry").value("무역"))
            .andExpect(jsonPath("$.context.companyConditions.establishedOn").value("2020-01-02"))
            .andExpect(jsonPath("$.context.companyConditions.supportPurpose").value("수출"))
            .andReturn().response.contentAsString
        val tree = mapper.readTree(restored)
        assertEquals(guest.get("programs").get(0), tree.get("programs").get(0))
        assertEquals(guest.get("programs").get(1), tree.get("programs").get(1))
        val retry = mvc.perform(restore(token).member()).andExpect(status().isOk()).andReturn().response.contentAsString
        assertEquals(tree, mapper.readTree(retry))
        mvc.perform(restore(token).member("member-two")).andExpect(status().isGone())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_SEARCH_RESULT_EXPIRED"))
        Mockito.verify(search, Mockito.times(1)).search("  무역 지원  ", false, conditions)
        Mockito.verifyNoMoreInteractions(search)
    }

    @Test
    fun expiredAndUnknownTokensReturnGoneWithoutSearching() {
        stubPost()
        val mvc = mvc()
        val guest = mapper.readTree(mvc.perform(postSearch()).andReturn().response.contentAsString)
        val key = "govbiz:search-result:v1:" + MessageDigest.getInstance("SHA-256")
            .digest(guest.get("resultToken").asText().toByteArray()).toHexString()
        connection.redis.expireAt(key, Instant.EPOCH)
        for (token in listOf(guest.get("resultToken").asText(), UUID.randomUUID().toString())) {
            mvc.perform(restore(token).member()).andExpect(status().isGone())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_SEARCH_RESULT_EXPIRED"))
        }
        Mockito.verify(search, Mockito.times(1)).search("  무역 지원  ", false, conditions)
        Mockito.verifyNoMoreInteractions(search)
    }

    @Test
    fun storeFailureIsUnavailableNotExpiredAndNeverLeaksPrivateDetailsOrSearchesOnRestore() {
        val failedRepository = Mockito.mock(SupportProgramSearchResultRepository::class.java)
        val token = UUID.randomUUID().toString()
        Mockito.`when`(failedRepository.claim(token, 1L)).thenThrow(SupportProgramSearchResultStoreException(IllegalStateException("private redis payload")))
        val body = mvc(previewService = SupportProgramSearchPreviewService(search, failedRepository))
            .perform(restore(token).member()).andExpect(status().isServiceUnavailable())
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_SEARCH_RESULT_STORE_UNAVAILABLE"))
            .andReturn().response.contentAsString
        assertFalse(body.contains("private redis payload"))
        Mockito.verifyNoInteractions(search)
    }

    @Test
    fun malformedRestoreBodiesAreRejectedBeforeAnySearch() {
        val mvc = mvc()
        val invalidTokens = listOf<Any?>(null, "", "not-a-token", " " + UUID.randomUUID(), "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", 123, true)
        val bodies = invalidTokens.map { mapper.writeValueAsString(mapOf("resultToken" to it)) } + "{}"
        for (body in bodies) {
            mvc.perform(post("$PATH/results").member().contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest()).andExpect(header().string("Cache-Control", "no-store"))
        }
        Mockito.verifyNoInteractions(search)
    }

    @Test
    fun invalidSessionsCannotTurnEitherSearchMethodIntoAnAnonymousPreview() {
        val mvc = mvc()
        for (request in listOf(get(PATH).queryParam("query", "무역"), postSearch(), restore(UUID.randomUUID().toString()))) {
            mvc.perform(request.member("expired-session")).andExpect(status().isUnauthorized())
                .andExpect(header().string("Cache-Control", "no-store"))
        }
        Mockito.verifyNoInteractions(search)
    }

    @Test
    fun restoreRequiresTrustedOriginWhenASessionCookieIsPresent() {
        val mvc = mvc()
        for (origin in listOf(null, "https://untrusted.invalid")) {
            val request = restore(UUID.randomUUID().toString()).cookie(Cookie("govbiz_session", "member-one"))
            if (origin != null) request.header("Origin", origin)
            mvc.perform(request).andExpect(status().isForbidden()).andExpect(header().string("Cache-Control", "no-store"))
        }
        Mockito.verifyNoInteractions(search, sessions)
    }

    private class MutableClock(private var now: Instant) : Clock() {
        override fun getZone(): ZoneId = ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock = this
        override fun instant(): Instant = now
        fun advance(duration: Duration) { now = now.plus(duration) }
    }

    private companion object {
        const val PATH = "/api/v1/support-programs/search"
        const val ORIGIN = "http://localhost:5173"
    }
}
