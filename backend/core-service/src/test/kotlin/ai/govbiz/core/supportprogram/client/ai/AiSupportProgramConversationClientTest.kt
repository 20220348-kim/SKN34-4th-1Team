package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core._common.config.JsonDeserializationConfig
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationCompanyConditionsRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationContextRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationLastSearchRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramPendingClarificationRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatusCode
import org.springframework.http.MediaType
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import org.springframework.test.json.JsonCompareMode
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.*
import org.springframework.test.web.client.response.MockRestResponseCreators.*
import org.springframework.web.client.RestClient
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class AiSupportProgramConversationClientTest {
    private val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).also {
        JsonDeserializationConfig().strictJsonRequestTypes().customize(it)
    }.build()
    private val builder = RestClient.builder().baseUrl("http://ai-service.test")
        .messageConverters { it.clear(); it.add(JacksonJsonHttpMessageConverter(mapper)) }
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = AiSupportProgramConversationClient(builder.build())
    private val context = AiSupportProgramConversationContextRequest(null, true, AiSupportProgramConversationCompanyConditionsRequest(null, null, null, null))
    private val request = AiSupportProgramConversationRequest(VERSION, "2026-09-07", "부산으로 변경", context, null)

    @AfterEach
    fun verifyRequests() = server.verify()

    @Test
    fun sendsExactSmallContextAndSeoulDateWithoutAnyConversationHistoryAndDecodesNullableFields() {
        server.expect(requestTo(URL)).andExpect(method(HttpMethod.POST))
            .andExpect(content().contentType(MediaType.APPLICATION_JSON))
            .andExpect(content().json("""{
              "schemaVersion":"$VERSION","referenceDate":"2026-09-07","message":"부산으로 변경",
              "context":{"query":null,"acceptingOnly":true,"companyConditions":{"region":null,"industry":null,"establishedOn":null,"supportPurpose":null}},
              "pendingClarification":null,"pendingProposal":null,"lastSearch":null
            }""", JsonCompareMode.STRICT))
            .andRespond(withSuccess(VALID_RESPONSE, MediaType.APPLICATION_JSON))
        val payload = client.interpret(request)
        assertEquals("READY", payload.status)
        assertNull(payload.clarificationQuestion)
        assertNull(payload.answer)
        assertEquals("부산", payload.updates!!.single()!!.value)
    }

    @Test
    fun sendsOnlyLastQuestionAndDraftAlongsideConfirmedContextWithIsoDates() {
        val draft = context.copy(query = "시제품 지원", acceptingOnly = false, companyConditions = context.companyConditions.copy(region = "부산", establishedOn = "2024-02-29"))
        server.expect(requestTo(URL)).andExpect(content().json("""{
          "schemaVersion":"$VERSION","referenceDate":"2026-09-07","message":"부산으로 변경",
          "context":{"query":null,"acceptingOnly":true,"companyConditions":{"region":null,"industry":null,"establishedOn":null,"supportPurpose":null}},
          "pendingClarification":{"question":"정확한 설립일은?","draftContext":{"query":"시제품 지원","acceptingOnly":false,"companyConditions":{"region":"부산","industry":null,"establishedOn":"2024-02-29","supportPurpose":null}}},
          "pendingProposal":null,"lastSearch":null
        }""", JsonCompareMode.STRICT)).andRespond(withSuccess("""{"schemaVersion":"$VERSION","status":"CLARIFICATION_REQUIRED","updates":[],"clarificationQuestion":"어떤 지원을 원하시나요?"}""", MediaType.APPLICATION_JSON))
        val payload = client.interpret(request.copy(pendingClarification = AiSupportProgramPendingClarificationRequest("정확한 설립일은?", draft)))
        assertEquals("CLARIFICATION_REQUIRED", payload.status)
        assertEquals(emptyList<Any>(), payload.updates)
    }

    @Test
    fun sendsPendingProposalAndCompletedSearchSummaryAndDecodesAnswered() {
        val proposal = context.copy(query = "무역 지원", companyConditions = context.companyConditions.copy(region = "대구"))
        val lastSearch = AiSupportProgramConversationLastSearchRequest(context.copy(query = "AI 창업 지원"), 0)
        server.expect(requestTo(URL)).andExpect(method(HttpMethod.POST))
            .andExpect(jsonPath("$.message").value("왜 못찾아?"))
            .andExpect(jsonPath("$.pendingProposal.query").value("무역 지원"))
            .andExpect(jsonPath("$.pendingProposal.companyConditions.region").value("대구"))
            .andExpect(jsonPath("$.lastSearch.context.query").value("AI 창업 지원"))
            .andExpect(jsonPath("$.lastSearch.resultCount").value(0))
            .andRespond(withSuccess("""{"schemaVersion":"$VERSION","status":"ANSWERED","updates":[],"clarificationQuestion":null,"answer":"직전 검색 결과는 0건입니다."}""", MediaType.APPLICATION_JSON))
        val payload = client.interpret(request.copy(message = "왜 못찾아?", pendingProposal = proposal, lastSearch = lastSearch))
        assertEquals("ANSWERED", payload.status)
        assertEquals("직전 검색 결과는 0건입니다.", payload.answer)
        assertEquals(emptyList<Any>(), payload.updates)
    }

    @ParameterizedTest
    @ValueSource(strings = ["true", "1", "1.5", "[]", "{}"])
    fun rejectsNonStringAnswersInsteadOfCoercingThem(value: String) {
        expectInvalidJson("""{"schemaVersion":"$VERSION","status":"ANSWERED","updates":[],"clarificationQuestion":null,"answer":$value}""")
    }

    @ParameterizedTest
    @ValueSource(strings = ["schemaVersion", "status", "updates", "clarificationQuestion"])
    fun rejectsMissingTopLevelResponseFieldsEvenWhenTheirValuesMayBeNull(field: String) {
        val response = linkedMapOf<String, Any?>("schemaVersion" to VERSION, "status" to "READY", "updates" to emptyList<Any>(), "clarificationQuestion" to null)
        response.remove(field)
        expectInvalidJson(mapper.writeValueAsString(response))
    }

    @ParameterizedTest
    @ValueSource(strings = ["field", "operation", "value", "evidence"])
    fun rejectsMissingUpdateFieldsIncludingClearValue(field: String) {
        val update = linkedMapOf<String, Any?>("field" to "REGION", "operation" to "CLEAR", "value" to null, "evidence" to "부산")
        update.remove(field)
        expectInvalidJson(mapper.writeValueAsString(mapOf("schemaVersion" to VERSION, "status" to "READY", "updates" to listOf(update), "clarificationQuestion" to null)))
    }

    @Test
    fun acceptsExplicitNullForClear() {
        server.expect(requestTo(URL)).andRespond(withSuccess(VALID_RESPONSE.replace("\"SET\"", "\"CLEAR\"").replace("\"value\":\"부산\"", "\"value\":null"), MediaType.APPLICATION_JSON))
        assertNull(client.interpret(request).updates!!.single()!!.value)
    }

    @ParameterizedTest
    @ValueSource(strings = ["true", "1", "1.5", "[]", "{}"])
    fun rejectsWrongJsonTypesInsteadOfCoercingThem(value: String) {
        expectInvalidJson(VALID_RESPONSE.replace("\"value\":\"부산\"", "\"value\":$value"))
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "null", "{", "[]"])
    fun rejectsEmptyOrMalformedSuccessfulResponses(json: String) = expectInvalidJson(json)

    @ParameterizedTest
    @ValueSource(ints = [204, 400, 408, 422, 500, 502, 503, 504])
    fun mapsHttpFailureWithoutLeakingTheAiBodyOrReturningFallback(status: Int) {
        server.expect(requestTo(URL)).andRespond(withStatus(HttpStatusCode.valueOf(status)).body("private-upstream-message"))
        val error = assertThrows(AiServiceCallException::class.java) { client.interpret(request) }
        assertEquals(when (status) {
            204 -> AiServiceFailure.INVALID_RESPONSE
            408, 504 -> AiServiceFailure.TIMEOUT
            503 -> AiServiceFailure.UNAVAILABLE
            else -> AiServiceFailure.UPSTREAM_ERROR
        }, error.failure)
        assertFalse(error.message!!.contains("private-upstream-message"))
    }

    private fun expectInvalidJson(json: String) {
        server.expect(requestTo(URL)).andRespond(withSuccess(json, MediaType.APPLICATION_JSON))
        assertEquals(AiServiceFailure.INVALID_RESPONSE, assertThrows(AiServiceCallException::class.java) { client.interpret(request) }.failure)
    }

    companion object {
        private const val VERSION = "govbiz-support-program-conversation-v1"
        private const val URL = "http://ai-service.test/internal/v1/support-program-conversation/interpret"
        private const val VALID_RESPONSE = """{"schemaVersion":"$VERSION","status":"READY","updates":[{"field":"REGION","operation":"SET","value":"부산","evidence":"부산"}],"clarificationQuestion":null}"""
    }
}
