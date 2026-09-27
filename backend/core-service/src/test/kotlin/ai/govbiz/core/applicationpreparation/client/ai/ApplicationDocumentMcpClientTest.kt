package ai.govbiz.core.applicationpreparation.client.ai

import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationRequest
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationDocumentMcpException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.http.MediaType
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.*
import org.springframework.test.web.client.response.MockRestResponseCreators.*
import org.springframework.web.client.RestClient
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class ApplicationDocumentMcpClientTest {
    private val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
    private val builder = RestClient.builder().baseUrl("http://ai.test")
        .messageConverters { it.clear(); it.add(JacksonJsonHttpMessageConverter(json)) }
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = ApplicationDocumentMcpClient(builder.build(), "t".repeat(32), json)

    @Test
    fun sendsConfirmedFactsBytesAndRevisionAndDecodesTheMcpContract() {
        val request = AiDocumentGenerationRequest(sourceBase64 = "dGVzdA==", sourceSha256 = "a".repeat(64), format = "hwpx",
            answerRevision = 7, facts = listOf(ApplicationDocumentFact("company:name", "기업명", "가상 & 연구소")), scope = "선택된 신청서")
        val response = mapOf("contractVersion" to "application-document-mcp-v1", "pipelineVersion" to "b".repeat(64),
            "sourceSha256" to request.sourceSha256, "answerRevision" to 7, "outputBase64" to "dGVzdA==", "outputSha256" to "c".repeat(64),
            "planHash" to "d".repeat(64), "mapVersion" to "native-map-v2", "engineVersion" to "stub",
            "verification" to mapOf("verified" to 1), "placements" to emptyList<Any>(), "documentMap" to emptyMap<String, Any>(),
            "writePlan" to mapOf("answerRevision" to 7))
        server.expect(requestTo("http://ai.test/internal/v1/application-preparations/document/generate"))
            .andExpect(header("Authorization", "Bearer " + "t".repeat(32)))
            .andExpect(content().json(json.writeValueAsString(request)))
            .andRespond(withSuccess(json.writeValueAsString(response), MediaType.APPLICATION_JSON))
        val result = client.generate(request)
        assertEquals(7L, result.answerRevision)
        assertEquals(request.sourceSha256, result.sourceSha256)
        assertEquals("native-map-v2", result.mapVersion)
        server.verify()
    }

    @ParameterizedTest
    @ValueSource(strings = ["APPLICATION_DOCUMENT_OVERFLOW", "APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED", "APPLICATION_DOCUMENT_UNMAPPED_INPUT", "APPLICATION_DOCUMENT_MCP_NOT_READY", "APPLICATION_DOCUMENT_MCP_FAILED", "APPLICATION_DOCUMENT_OUTCOME_UNKNOWN"])
    fun preservesTypedToolFailuresWithoutDocumentText(code: String) {
        server.expect(requestTo("http://ai.test/internal/v1/application-preparations/document/generate"))
            .andRespond(withStatus(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE)
                .contentType(MediaType.APPLICATION_JSON).body("""{"detail":{"code":"$code","documentText":"never expose"}}"""))
        val request = AiDocumentGenerationRequest(sourceBase64 = "", sourceSha256 = "", format = "pdf", answerRevision = 1, facts = emptyList(), scope = "test")
        val error = assertThrows(ApplicationDocumentMcpException::class.java) { client.generate(request) }
        assertEquals(code, error.code)
        assertFalse(error.message!!.contains("never expose"))
        server.verify()
    }

    private fun request() = AiDocumentGenerationRequest(sourceBase64 = "", sourceSha256 = "", format = "pdf",
        answerRevision = 1, facts = emptyList(), scope = "test")

    @Test fun shortTokenRemainsNotReady() {
        val unconfigured = ApplicationDocumentMcpClient(builder.build(), "short", json)
        val error = assertThrows(ApplicationDocumentMcpException::class.java) { unconfigured.generate(request()) }
        assertEquals("APPLICATION_DOCUMENT_MCP_NOT_READY", error.code)
        server.verify()
    }

    @ParameterizedTest
    @ValueSource(strings = ["{bad-json", "{\"detail\":{\"code\":\"PRIVATE_CODE\"}}"])
    fun invalidOrUnrecognizedRemoteErrorRemainsMcpFailed(body: String) {
        server.expect(requestTo("http://ai.test/internal/v1/application-preparations/document/generate"))
            .andRespond(withServerError().contentType(MediaType.APPLICATION_JSON).body(body))
        val error = assertThrows(ApplicationDocumentMcpException::class.java) { client.generate(request()) }
        assertEquals("APPLICATION_DOCUMENT_MCP_FAILED", error.code)
        server.verify()
    }

    @Test fun malformedSuccessRemainsUnknownOutcome() {
        server.expect(requestTo("http://ai.test/internal/v1/application-preparations/document/generate"))
            .andRespond(withSuccess("{bad-json", MediaType.APPLICATION_JSON))
        val error = assertThrows(ApplicationDocumentMcpException::class.java) { client.generate(request()) }
        assertEquals("APPLICATION_DOCUMENT_OUTCOME_UNKNOWN", error.code)
        assertNotNull(error.cause)
        server.verify()
    }

    @Test fun transportTimeoutRemainsUnknownOutcome() {
        server.expect(requestTo("http://ai.test/internal/v1/application-preparations/document/generate"))
            .andRespond { throw java.net.SocketTimeoutException("private upstream address") }
        val error = assertThrows(ApplicationDocumentMcpException::class.java) { client.generate(request()) }
        assertEquals("APPLICATION_DOCUMENT_OUTCOME_UNKNOWN", error.code)
        assertFalse(error.message!!.contains("private upstream"))
        server.verify()
    }
}
