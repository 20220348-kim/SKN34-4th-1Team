package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core._common.config.JsonDeserializationConfig
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramConversationRequest
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationStatus
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.conversation.SupportProgramConversationService
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.dto.SupportProgramConversationResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchResult
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.readiness.SupportProgramSearchReadinessService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchPreviewService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.time.Clock
import ai.govbiz.core.supportprogram.repository.SupportProgramSearchResultRepository
import java.time.Instant
import java.time.ZoneOffset
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mockito
import org.springframework.http.MediaType
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class SupportProgramConversationControllerTest {
    private val service = Mockito.mock(SupportProgramConversationService::class.java)
    private val search = Mockito.mock(SupportProgramSearchService::class.java)
    private val detail = Mockito.mock(SupportProgramDetailService::class.java)
    private val evidence = Mockito.mock(SupportProgramEvidenceService::class.java)
    private val readiness = Mockito.mock(SupportProgramSearchReadinessService::class.java)
    private val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).also {
        JsonDeserializationConfig().strictJsonRequestTypes().customize(it)
    }.build()
    private val validator = LocalValidatorFactoryBean().apply {
        setConfigurationInitializer { it.clockProvider { Clock.fixed(Instant.parse("2026-09-06T15:00:00Z"), ZoneOffset.UTC) } }
        afterPropertiesSet()
    }
    private val emptyContext = SupportProgramConversationContext(null, true, SupportProgramCompanyConditions())

    @AfterEach
    fun closeValidatorAndVerifyNoDetailEvidenceOrReadinessCalls() {
        validator.close()
        Mockito.verifyNoInteractions(detail, evidence, readiness)
    }

    private fun mvc(perClient: Int = 100, global: Int = 100, concurrent: Int = 4): MockMvc {
        val admission = SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties(perClient, global, concurrent)) { 0L }
        return MockMvcBuilders.standaloneSetup(
            SupportProgramConversationController(service, admission),
            SupportProgramController(SupportProgramSearchPreviewService(search, Mockito.mock(SupportProgramSearchResultRepository::class.java)), readiness, detail, evidence, admission),
        ).setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver { Mockito.mock(AccountSessionService::class.java) })
            .setControllerAdvice(ApiExceptionHandler()).setValidator(validator)
            .setMessageConverters(JacksonJsonHttpMessageConverter(mapper)).build()
    }

    private fun request(json: String = body()) = post(URL).contentType(MediaType.APPLICATION_JSON).content(json)
        .with { it.remoteAddr = "192.0.2.1"; it }

    private fun contextJson() = linkedMapOf<String, Any?>(
        "query" to null, "acceptingOnly" to true,
        "companyConditions" to linkedMapOf<String, Any?>("region" to null, "industry" to null, "establishedOn" to null, "supportPurpose" to null),
    )

    private fun body(
        context: Map<String, Any?> = contextJson(), message: Any? = "부산으로 변경", pending: Any? = null,
        proposal: Any? = null, lastSearch: Any? = null,
    ) = mapper.writeValueAsString(mapOf(
        "message" to message, "context" to context, "pendingClarification" to pending,
        "pendingProposal" to proposal, "lastSearch" to lastSearch,
    ))

    private fun stubClarification() {
        Mockito.`when`(service.interpret("부산으로 변경", emptyContext, null)).thenReturn(
            SupportProgramConversationResult(SupportProgramConversationStatus.CLARIFICATION_REQUIRED, emptyContext, "어떤 지원을 원하시나요?", emptyList()),
        )
    }

    @Test
    fun sendsUnconfirmedProposalAndZeroResultSummaryAndReturnsAnswerWithoutSearching() {
        val proposal = contextJson().apply { put("query", "무역 지원") }
        val json = body(message = "왜 못찾아?", proposal = proposal, lastSearch = mapOf("context" to contextJson(), "resultCount" to 0))
        val dto = mapper.readValue(json, SupportProgramConversationRequest::class.java)
        val expectedProposal = dto.pendingProposal!!.toDomain()
        val expectedLastSearch = dto.lastSearch!!.toDomain()
        val answer = "직전 검색 결과는 0건입니다.\n원인을 확정할 자료는 없습니다."
        Mockito.`when`(service.interpret(dto.message, emptyContext, null, expectedProposal, expectedLastSearch)).thenReturn(
            SupportProgramConversationResult(SupportProgramConversationStatus.ANSWERED, expectedProposal, null, emptyList(), answer),
        )
        val result = mvc().perform(request(json)).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("ANSWERED"))
            .andExpect(jsonPath("$.proposedContext.query").value("무역 지원"))
            .andExpect(jsonPath("$.answer").value(answer)).andReturn().response.contentAsString
        assertTrue(mapper.readTree(result).get("clarificationQuestion").isNull)
        Mockito.verify(service).interpret(dto.message, emptyContext, null, expectedProposal, expectedLastSearch)
        Mockito.verifyNoInteractions(search)
    }

    @Test
    fun rejectsSimultaneousPendingQuestionAndProposalAndMalformedNestedContexts() {
        val mvc = mvc()
        mvc.perform(request(body(pending = mapOf("question" to "어느 지역인가요?", "draftContext" to contextJson()), proposal = contextJson())))
            .andExpect(status().isBadRequest())
        for (invalidContext in listOf(emptyMap<String, Any?>(), contextJson().apply { put("query", " ") }, contextJson().apply { put("acceptingOnly", null) })) {
            mvc.perform(request(body(proposal = invalidContext))).andExpect(status().isBadRequest())
            mvc.perform(request(body(lastSearch = mapOf("context" to invalidContext, "resultCount" to 0)))).andExpect(status().isBadRequest())
        }
        val invalidDate = contextJson()
        @Suppress("UNCHECKED_CAST")
        (invalidDate["companyConditions"] as MutableMap<String, Any?>)["establishedOn"] = "2025-02-29"
        mvc.perform(request(body(proposal = invalidDate))).andExpect(status().isBadRequest())
        mvc.perform(request(body(lastSearch = mapOf("context" to invalidDate, "resultCount" to 0)))).andExpect(status().isBadRequest())
        Mockito.verifyNoInteractions(service, search)
    }

    @Test
    fun requiresANonnegativeIntegerCountAndACompleteContextForLastSearch() {
        val mvc = mvc()
        for (value in listOf(null, -1, 1.5, 1.0, "0", true, 2147483648L)) {
            mvc.perform(request(body(lastSearch = mapOf("context" to contextJson(), "resultCount" to value)))).andExpect(status().isBadRequest())
        }
        for (lastSearch in listOf(emptyMap<String, Any?>(), mapOf("context" to contextJson()), mapOf("resultCount" to 0), mapOf("context" to null, "resultCount" to 0))) {
            mvc.perform(request(body(lastSearch = lastSearch))).andExpect(status().isBadRequest())
        }
        Mockito.verifyNoInteractions(service, search)
    }

    @Test
    fun explicitlyNullUnspecifiedFieldsAreAcceptedAndEveryResponseKeyIsPreserved() {
        stubClarification()
        val response = mvc().perform(request()).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("CLARIFICATION_REQUIRED"))
            .andExpect(jsonPath("$.changedFields").isEmpty()).andReturn().response.contentAsString
        val tree = mapper.readTree(response)
        assertTrue(tree.has("answer"))
        assertTrue(tree.get("answer").isNull)
        val proposed = tree.get("proposedContext")
        assertTrue(proposed.has("query"))
        assertTrue(proposed.get("query").isNull)
        for (field in listOf("region", "industry", "establishedOn", "supportPurpose")) {
            assertTrue(proposed.get("companyConditions").has(field))
            assertTrue(proposed.get("companyConditions").get(field).isNull)
        }
        Mockito.verify(service).interpret("부산으로 변경", emptyContext, null)
        Mockito.verifyNoInteractions(search)
    }

    @Test
    fun pendingClarificationCanBeOmittedButContextAndAllOfItsNullableKeysAreRequiredOverHttp() {
        stubClarification()
        val mvc = mvc()
        mvc.perform(request(mapper.writeValueAsString(mapOf("message" to "부산으로 변경", "context" to contextJson())))).andExpect(status().isOk())
        for (field in listOf("query", "acceptingOnly", "companyConditions")) {
            mvc.perform(request(body(contextJson().apply { remove(field) }))).andExpect(status().isBadRequest())
        }
        for (field in listOf("region", "industry", "establishedOn", "supportPurpose")) {
            val context = contextJson()
            @Suppress("UNCHECKED_CAST")
            (context["companyConditions"] as MutableMap<String, Any?>).remove(field)
            mvc.perform(request(body(context))).andExpect(status().isBadRequest())
        }
        for (json in listOf("{}", """{"message":"부산"}""", """{"message":"부산","context":null}""")) {
            mvc.perform(request(json)).andExpect(status().isBadRequest())
        }
        Mockito.verify(service, Mockito.times(1)).interpret("부산으로 변경", emptyContext, null)
    }

    @ParameterizedTest
    @ValueSource(strings = ["null", "\"false\"", "0", "1", "0.0", "\"\""])
    fun rejectsBooleanNullAndCoercionOverHttp(value: String) {
        mvc().perform(request(body().replace("\"acceptingOnly\":true", "\"acceptingOnly\":$value"))).andExpect(status().isBadRequest())
        Mockito.verifyNoInteractions(service, search)
    }

    @Test
    fun rejectsScalarCoercionForMessageQueryAndEveryCompanyStringOverHttp() {
        val mvc = mvc()
        for (value in listOf(1, false, 1.25)) {
            mvc.perform(request(body(message = value))).andExpect(status().isBadRequest())
            mvc.perform(request(body(contextJson().apply { put("query", value) }))).andExpect(status().isBadRequest())
            for (field in listOf("region", "industry", "establishedOn", "supportPurpose")) {
                val context = contextJson()
                @Suppress("UNCHECKED_CAST")
                (context["companyConditions"] as MutableMap<String, Any?>)[field] = value
                mvc.perform(request(body(context))).andExpect(status().isBadRequest())
            }
        }
        Mockito.verifyNoInteractions(service, search)
    }

    @Test
    fun validatesPendingQuestionAndEveryDraftFieldBeforeCallingService() {
        val mvc = mvc()
        for (pending in listOf(emptyMap<String, Any?>(), mapOf("question" to "설립일?"), mapOf("draftContext" to contextJson()), mapOf("question" to null, "draftContext" to contextJson()), mapOf("question" to "설립일?", "draftContext" to null))) {
            mvc.perform(request(body(pending = pending))).andExpect(status().isBadRequest())
        }
        for (question in listOf(" ", "가".repeat(161), "😀".repeat(81), "질문\n", "질문\u200b")) {
            mvc.perform(request(body(pending = mapOf("question" to question, "draftContext" to contextJson())))).andExpect(status().isBadRequest())
        }
        for (field in listOf("query", "acceptingOnly", "companyConditions")) {
            mvc.perform(request(body(pending = mapOf("question" to "설립일?", "draftContext" to contextJson().apply { remove(field) })))).andExpect(status().isBadRequest())
        }
        for (field in listOf("region", "industry", "establishedOn", "supportPurpose")) {
            val draft = contextJson()
            @Suppress("UNCHECKED_CAST")
            (draft["companyConditions"] as MutableMap<String, Any?>).remove(field)
            mvc.perform(request(body(pending = mapOf("question" to "설립일?", "draftContext" to draft)))).andExpect(status().isBadRequest())
        }
        Mockito.verifyNoInteractions(service, search)
    }

    @Test
    fun validatesRawUtf16TextLimitsControlCharactersAndRealCalendarDates() {
        val mvc = mvc()
        for (message in listOf("", " ", "\u00a0", "가".repeat(501), "😀".repeat(251), "AI\u0000", "AI\u200b")) mvc.perform(request(body(message = message))).andExpect(status().isBadRequest())
        for ((field, limit) in listOf("region" to 50, "industry" to 100, "supportPurpose" to 100)) {
            for (value in listOf("", " ", "가".repeat(limit + 1), "😀".repeat(limit / 2 + 1), "가\n", "가\r", "가\t", "가\u0000", "가\u200b")) {
                val context = contextJson()
                @Suppress("UNCHECKED_CAST")
                (context["companyConditions"] as MutableMap<String, Any?>)[field] = value
                mvc.perform(request(body(context))).andExpect(status().isBadRequest())
            }
        }
        for (date in listOf("", " ", "1899-12-31", "2026-09-08", "2025-02-29", "2026-02-30", "2026-9-07", " 2024-01-01", "2024-01-01 ", "2024-01-01T00:00:00")) {
            val context = contextJson()
            @Suppress("UNCHECKED_CAST")
            (context["companyConditions"] as MutableMap<String, Any?>)["establishedOn"] = date
            mvc.perform(request(body(context))).andExpect(status().isBadRequest())
        }
        for (query in listOf("", " ", "가".repeat(501), "😀".repeat(251), "AI\u0000")) mvc.perform(request(body(contextJson().apply { put("query", query) }))).andExpect(status().isBadRequest())
        Mockito.verifyNoInteractions(service, search)
    }

    @Test
    fun validNestedDraftAndRawBoundaryValuesArePassedWithoutTrimmingOrAutonomousSearch() {
        val context = contextJson().apply { put("query", "가".repeat(500)); put("acceptingOnly", false) }
        @Suppress("UNCHECKED_CAST")
        (context["companyConditions"] as MutableMap<String, Any?>).putAll(mapOf("region" to " 😀 ", "industry" to "😀".repeat(50), "establishedOn" to "2026-09-07", "supportPurpose" to "가".repeat(100)))
        val json = body(context, "AI\n지원\t사업\r", mapOf("question" to "😀".repeat(80), "draftContext" to context))
        val dto = mapper.readValue(json, SupportProgramConversationRequest::class.java)
        val expected = dto.context.toDomain()
        val pending = dto.pendingClarification!!.toDomain()
        Mockito.`when`(service.interpret(dto.message, expected, pending)).thenReturn(SupportProgramConversationResult(SupportProgramConversationStatus.READY, expected, null, emptyList()))
        val raw = mvc().perform(request(json)).andExpect(status().isOk()).andReturn().response.contentAsString
        assertTrue(mapper.readTree(raw).has("clarificationQuestion"))
        assertTrue(mapper.readTree(raw).get("clarificationQuestion").isNull)
        Mockito.verify(service).interpret(dto.message, expected, pending)
        Mockito.verifyNoInteractions(search)
    }

    @Test
    fun interpretationAndConfirmedSearchChargeTheSamePerClientQuotaSeparately() {
        stubClarification()
        val mvc = mvc(perClient = 1)
        mvc.perform(request()).andExpect(status().isOk())
        mvc.perform(post("/api/v1/support-programs/search").contentType(MediaType.APPLICATION_JSON).content("""{"query":"AI"}""").with { it.remoteAddr = "192.0.2.1"; it })
            .andExpect(status().isTooManyRequests()).andExpect(header().string("Retry-After", "60"))
        Mockito.verifyNoInteractions(search)
    }

    @Test
    fun existingSearchAlsoConsumesInterpretationQuotaAndInvalidInputDoesNot() {
        val mvc = mvc(perClient = 1)
        mvc.perform(request("{}")).andExpect(status().isBadRequest())
        Mockito.`when`(search.search("AI", true)).thenReturn(SupportProgramSearchResult("AI", emptyList()))
        mvc.perform(get("/api/v1/support-programs/search").param("query", "AI").with { it.remoteAddr = "192.0.2.1"; it }).andExpect(status().isOk())
        mvc.perform(request()).andExpect(status().isTooManyRequests())
        Mockito.verifyNoInteractions(service)
    }

    @Test
    fun aiErrorsAreExplicitConsumeQuotaAndReleaseTheConcurrentSlot() {
        Mockito.`when`(service.interpret("부산으로 변경", emptyContext, null)).thenThrow(AiServiceCallException.timeout(null))
        val mvc = mvc(perClient = 2, concurrent = 1)
        mvc.perform(request()).andExpect(status().isGatewayTimeout())
        mvc.perform(request()).andExpect(status().isGatewayTimeout())
        mvc.perform(request()).andExpect(status().isTooManyRequests())
        Mockito.verify(service, Mockito.times(2)).interpret("부산으로 변경", emptyContext, null)
        Mockito.verifyNoInteractions(search)
    }

    companion object { private const val URL = "/api/v1/support-programs/conversation/interpret" }
}
