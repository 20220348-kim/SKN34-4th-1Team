package ai.govbiz.core.applicationpreparation.client.ai

import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationOnlineFormMcpException
import ai.govbiz.core.applicationpreparation.client.ai.mapper.ApplicationOnlineFormMcpMapper
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.*
import org.springframework.test.web.client.response.MockRestResponseCreators.*
import org.springframework.web.client.RestClient
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class ApplicationOnlineFormMcpClientTest {
    private val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
    private val builder = RestClient.builder().baseUrl("http://ai.test")
        .messageConverters { it.clear(); it.add(JacksonJsonHttpMessageConverter(json)) }
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = ApplicationOnlineFormMcpClient(builder.build(), "t".repeat(32), json, ApplicationOnlineFormMcpMapper())
    private val path = "http://ai.test/internal/v1/application-preparations/online-form/inspect"
    private val url = "https://docs.google.com/forms/d/e/public-id/viewform"

    private fun question(id: String = "gpub-v1:1:abcd", kind: String = "SHORT_TEXT", supported: Boolean = true) =
        mapOf("order" to 1, "controlId" to id, "label" to "업체명", "required" to true,
            "kind" to kind, "options" to emptyList<String>(), "supported" to supported,
            "unsupportedReason" to if (supported) null else "UNRECOGNIZED_CONTROL")

    private fun payload(questions: List<Map<String, Any?>> = listOf(question())): Map<String, Any> = mapOf(
        "contractVersion" to "google-public-form-reader-v1", "parserVersion" to "semantic-dom-v1",
        "sourceUrl" to url, "finalUrl" to url, "formTitle" to "공개 신청서",
        "semanticFingerprint" to "a".repeat(64), "questions" to questions,
    )

    private fun expectOk(value: Map<String, Any>) {
        server.expect(requestTo(path)).andExpect(method(org.springframework.http.HttpMethod.POST))
            .andExpect(header("Authorization", "Bearer " + "t".repeat(32)))
            .andExpect(content().json(json.writeValueAsString(mapOf("url" to url))))
            .andRespond(withSuccess(json.writeValueAsString(value), MediaType.APPLICATION_JSON))
    }

    @Test fun validPayloadBecomesOnlineFormSource() {
        expectOk(payload())
        val source = client.inspect(url)
        assertEquals(1, source.schemaVersion)
        assertTrue(source.formId.startsWith("gpub-form-v1:"))
        assertEquals("공개 신청서", source.formTitle)
        assertEquals("gpub-v1:1:abcd", source.controls.single().controlId)
        assertTrue(source.controls.single().required)
        server.verify()
    }

    @Test fun authenticationFailureIsTypedWithoutLeakingBody() {
        server.expect(requestTo(path)).andRespond(withStatus(HttpStatus.UNAUTHORIZED)
            .contentType(MediaType.APPLICATION_JSON).body("""{"detail":{"code":"UNAUTHORIZED","secret":"private"}}"""))
        val error = assertThrows(ApplicationOnlineFormMcpException::class.java) { client.inspect(url) }
        assertEquals("APPLICATION_ONLINE_FORM_MCP_FAILED", error.code)
        assertFalse(error.message!!.contains("private"))
        server.verify()
    }

    @Test fun knownAiErrorPropagates() {
        server.expect(requestTo(path)).andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE)
            .contentType(MediaType.APPLICATION_JSON).body("""{"detail":{"code":"APPLICATION_ONLINE_FORM_SOURCE_UNAVAILABLE"}}"""))
        assertEquals("APPLICATION_ONLINE_FORM_SOURCE_UNAVAILABLE",
            assertThrows(ApplicationOnlineFormMcpException::class.java) { client.inspect(url) }.code)
        server.verify()
    }

    @Test fun malformedContractsFailExplicitly() {
        val base = payload()
        val duplicate = listOf(question(), question().toMutableMap().also { it["order"] = 2 })
        val tooMany = (1..201).map { index -> question("gpub-v1:$index:abcd").toMutableMap().also { it["order"] = index } }
        val cases = listOf(
            base + ("contractVersion" to "unknown"),
            base + ("parserVersion" to "unknown"),
            base + ("questions" to duplicate),
            base + ("questions" to emptyList<Map<String, Any?>>()),
            base + ("questions" to tooMany),
            base + ("semanticFingerprint" to "bad"),
        )
        cases.forEach(::expectOk)
        cases.forEach {
            assertEquals("APPLICATION_ONLINE_FORM_SOURCE_CHANGED",
                assertThrows(ApplicationOnlineFormMcpException::class.java) { client.inspect(url) }.code)
        }
        server.verify()
    }

    @Test fun unsupportedQuestionIsNotConvertedToCompleteSource() {
        expectOk(payload(listOf(question(kind = "UNKNOWN", supported = false))))
        assertEquals("APPLICATION_ONLINE_FORM_UNSUPPORTED",
            assertThrows(ApplicationOnlineFormMcpException::class.java) { client.inspect(url) }.code)
        server.verify()
    }
}
