package ai.govbiz.core.assistant.client

import ai.govbiz.core._common.config.JsonDeserializationConfig
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.assistant.client.dto.AiAssistantAgentRequest
import ai.govbiz.core.assistant.client.dto.AiAssistantAnswerRequest
import ai.govbiz.core.assistant.client.dto.AiAssistantPrincipal
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
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

/** AI Service `tests/assistant/conftest.py`의 요청·출력 fixture와 같은 본문을 주고받는지 확인합니다. */
class AiAssistantClientTest {
    private val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).also {
        JsonDeserializationConfig().strictJsonRequestTypes().customize(it)
    }.build()
    private val builder = RestClient.builder().baseUrl("http://ai-service.test")
        .messageConverters { it.clear(); it.add(JacksonJsonHttpMessageConverter(mapper)) }
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = AiAssistantClient(builder.build())
    private val requestJson = resource("contract-request.json")
    private val request = mapper.readValue(requestJson, AiAssistantAnswerRequest::class.java)

    @AfterEach
    fun verifyRequests() = server.verify()

    @Test
    fun sendsTheSharedContractAndDecodesNullableIntentFields() {
        server.expect(requestTo(URL)).andExpect(method(HttpMethod.POST))
            .andExpect(content().contentType(MediaType.APPLICATION_JSON))
            .andExpect(content().json(requestJson, JsonCompareMode.STRICT))
            .andRespond(withSuccess(resource("contract-response.json"), MediaType.APPLICATION_JSON))
        val payload = client.answer(request)
        assertEquals("govbiz-assistant-v1", payload.schemaVersion)
        assertEquals("PRODUCT_HELP", payload.intent)
        assertEquals(listOf("search-score-meaning"), payload.citations)
        assertNull(payload.clarificationQuestion)
        assertNull(payload.searchQuery)
        assertNull(payload.accountTopic)
    }

    @ParameterizedTest
    @CsvSource("503,UNAVAILABLE", "504,TIMEOUT", "408,TIMEOUT", "500,UPSTREAM_ERROR", "422,UPSTREAM_ERROR", "204,INVALID_RESPONSE")
    fun mapsAiServiceStatusesToSharedFailures(status: Int, failure: AiServiceFailure) {
        server.expect(requestTo(URL)).andRespond(withStatus(HttpStatusCode.valueOf(status)))
        val error = assertThrows(AiServiceCallException::class.java) { client.answer(request) }
        assertEquals(failure, error.failure)
    }

    @Test
    fun sendsTheAgentContractWithThePrincipalAndDecodesCards() {
        val agentRequest = AiAssistantAgentRequest(
            "govbiz-assistant-agent-v1", request.message, request.history, request.session, request.context, request.helpEntries,
            AiAssistantPrincipal(7L, "7.1900000000.sig", true),
        )
        val expectedJson = requestJson.replace("govbiz-assistant-v1", "govbiz-assistant-agent-v1").trimEnd().removeSuffix("}") +
            ""","principal":{"accountId":7,"toolToken":"7.1900000000.sig","hasCompany":true},"savedProgramDocuments":null,"resumeIntent":null}"""
        server.expect(requestTo(AGENT_URL)).andExpect(method(HttpMethod.POST))
            .andExpect(content().json(expectedJson, JsonCompareMode.STRICT))
            .andRespond(withSuccess(resource("contract-agent-response.json"), MediaType.APPLICATION_JSON))
        val payload = client.agent(agentRequest)
        assertEquals("govbiz-assistant-agent-v1", payload.schemaVersion)
        assertEquals("PARTNER_MATCH", payload.intent)
        assertEquals("21", payload.cards!!.single()!!.id)
        assertEquals("/app/partners/detail?recruitmentId=21", payload.cards!!.single()!!.to)
        assertEquals("/app/partners", payload.navigation!!.to)
        assertEquals(listOf(true, true), payload.toolCalls!!.map { it!!.ok })
    }

    @ParameterizedTest
    @CsvSource("503,UNAVAILABLE", "504,TIMEOUT", "204,INVALID_RESPONSE", "500,UPSTREAM_ERROR")
    fun mapsAgentStatusesToTheSameFailures(status: Int, failure: AiServiceFailure) {
        server.expect(requestTo(AGENT_URL)).andRespond(withStatus(HttpStatusCode.valueOf(status)))
        val agentRequest = AiAssistantAgentRequest("govbiz-assistant-agent-v1", request.message, request.history, request.session, request.context, request.helpEntries, null)
        val error = assertThrows(AiServiceCallException::class.java) { client.agent(agentRequest) }
        assertEquals(failure, error.failure)
    }

    @Test
    fun treatsUndecodableBodiesAsInvalidResponses() {
        server.expect(requestTo(URL)).andRespond(withSuccess("""{"intent":["not","a","string"]}""", MediaType.APPLICATION_JSON))
        val error = assertThrows(AiServiceCallException::class.java) { client.answer(request) }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, error.failure)
    }

    private fun resource(name: String) =
        requireNotNull(javaClass.getResourceAsStream("/assistant/$name")).bufferedReader().use { it.readText() }

    private companion object {
        const val URL = "http://ai-service.test/internal/v1/assistant/answers"
        const val AGENT_URL = "http://ai-service.test/internal/v1/assistant/agent"
    }
}
