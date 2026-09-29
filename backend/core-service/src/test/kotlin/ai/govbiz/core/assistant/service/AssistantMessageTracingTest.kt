package ai.govbiz.core.assistant.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.assistant.client.AiAssistantClient
import ai.govbiz.core.assistant.client.dto.AiAssistantChunkRef
import ai.govbiz.core.assistant.client.dto.AiAssistantSavedProgramDocument
import ai.govbiz.core.assistant.config.AssistantAgentProperties
import ai.govbiz.core.assistant.domain.AssistantHelpEntry
import ai.govbiz.core.assistant.domain.AssistantQuestion
import ai.govbiz.core.assistant.domain.AssistantScreenContext
import ai.govbiz.core.assistant.helper.AssistantTracingHelper
import ai.govbiz.core.partner.service.PartnerProposalService
import ai.govbiz.core.supportprogram.service.saved.SavedSupportProgramService
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor
import java.time.Clock
import java.time.LocalDateTime
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
import org.mockito.Mockito
import org.mockito.Mockito.`when`
import org.springframework.http.HttpStatusCode
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

/** 실제 Service → Client HTTP 경계를 통과시키되 DB·모델 호출은 하지 않는다. */
class AssistantMessageTracingTest {
    private val exporter = InMemorySpanExporter.create()
    private val provider = SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build()
    private val tracing = AssistantTracingHelper(provider.get("test"))
    private val builder = RestClient.builder().baseUrl("http://ai.test")
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val documents = Mockito.mock(AssistantSavedProgramDocumentService::class.java)
    private val properties = AssistantAgentProperties(agentEnabled = true, toolsSecret = "private-test-secret-with-32-characters")
    private val service = AssistantMessageService(
        AiAssistantClient(builder.build()), Mockito.mock(SavedSupportProgramService::class.java),
        Mockito.mock(PartnerProposalService::class.java), Clock.systemUTC(), properties,
        AssistantToolTokenService(properties, Clock.systemUTC()), documents, tracing,
    )
    private val account = Account(7L, "private-account@example.com", AccountRole.USER, LocalDateTime.now(), null, LocalDateTime.now())
    private val question = AssistantQuestion("PRIVATE QUESTION", emptyList(), AssistantScreenContext("/app/chat", false), listOf(
        AssistantHelpEntry("help", "안내", "질문", "요약", listOf("설명"), "제약", "public", "available", null),
    ))
    private val document = AiAssistantSavedProgramDocument(
        "BIZINFO", "PBLN_PRIVATE", "PRIVATE DOCUMENT", null, "BIZINFO:PBLN_PRIVATE",
        listOf(AiAssistantChunkRef("c".repeat(64), "d".repeat(64))),
    )
    private val headers = mutableListOf<String>()

    private fun expect() = server.expect(requestTo("http://ai.test/internal/v1/assistant/agent"))
        .andExpect { request ->
            val header = request.headers.getFirst("traceparent")
            assertNotNull(header)
            assertEquals(AssistantTracingHelper.currentTraceParent(), header)
            headers += header!!
            assertNull(request.headers.getFirst("baggage"))
        }

    private fun response(needsDocuments: Boolean) = """{
        "schemaVersion":"govbiz-assistant-agent-v1","intent":"SAVED_PROGRAMS_QUESTION",
        "answer":"PRIVATE ANSWER","citations":[],"cards":[],"toolCalls":[],"needsDocuments":$needsDocuments
    }"""

    @AfterEach
    fun close() {
        try {
            server.verify()
            assertNull(AssistantTracingHelper.currentTraceParent())
            val spans = exporter.finishedSpanItems
            assertTrue(spans.all { it.events.isEmpty() })
            for (private in listOf("PRIVATE", account.email, properties.toolsSecret)) {
                assertFalse(spans.toString().contains(private))
            }
        } finally {
            provider.close()
        }
    }

    @Test
    fun firstCallAndDocumentResumeShareOneTraceWithDistinctHttpParents() {
        `when`(documents.prepare(7L)).thenReturn(AssistantSavedProgramDocumentService.PreparedDocuments(listOf(document), emptyMap()))
        expect().andRespond(withSuccess(response(true), MediaType.APPLICATION_JSON))
        expect().andRespond(withSuccess(response(false), MediaType.APPLICATION_JSON))
        assertEquals("PRIVATE ANSWER", service.answer(account, question).answer)
        val spans = exporter.finishedSpanItems
        val root = spans.single { it.name == "assistant.total" }
        assertEquals(6, spans.size)
        assertEquals("0000000000000000", root.parentSpanId)
        assertTrue(spans.all { it.traceId == root.traceId })
        assertTrue(spans.filter { it != root }.all { it.parentSpanId == root.spanId })
        assertEquals(listOf("assistant.core.request", "assistant.core.resume_request"), headers.map { header ->
            spans.single { "00-${it.traceId}-${it.spanId}-01" == header }.name
        })
        assertTrue(spans.all { it.attributes.get(AttributeKey.stringKey("langfuse.observation.metadata.outcome")) == "completed" })
    }

    @ParameterizedTest
    @CsvSource("503,UNAVAILABLE,failed", "504,TIMEOUT,timeout")
    fun preservesHttpFailuresAndEndsBothSpans(status: Int, failure: AiServiceFailure, outcome: String) {
        expect().andRespond(withStatus(HttpStatusCode.valueOf(status)).body("PRIVATE UPSTREAM FAILURE"))
        val error = assertThrows(AiServiceCallException::class.java) { service.answer(account, question) }
        assertEquals(failure, error.failure)
        val spans = exporter.finishedSpanItems
        assertEquals(2, spans.size)
        assertTrue(spans.all { it.status.statusCode == StatusCode.ERROR })
        assertTrue(spans.all { it.attributes.get(AttributeKey.stringKey("langfuse.observation.status_message")) == outcome })
        Mockito.verifyNoInteractions(documents)
    }

    @Test
    fun attributesInvalidResumeToValidationAndDoesNotRetry() {
        `when`(documents.prepare(7L)).thenReturn(AssistantSavedProgramDocumentService.PreparedDocuments(listOf(document), emptyMap()))
        expect().andRespond(withSuccess(response(true), MediaType.APPLICATION_JSON))
        expect().andRespond(withSuccess(response(true), MediaType.APPLICATION_JSON))
        val error = assertThrows(AiServiceCallException::class.java) { service.answer(account, question) }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, error.failure)
        assertEquals(setOf("assistant.total", "assistant.core.validate_resume"), exporter.finishedSpanItems
            .filter { it.status.statusCode == StatusCode.ERROR }.map { it.name }.toSet())
        assertEquals(2, headers.size)
    }

    @Test
    fun emptyDocumentsSkipResumeAndPreparationFailureIsVisible() {
        expect().andRespond(withSuccess(response(true), MediaType.APPLICATION_JSON))
        `when`(documents.prepare(7L)).thenReturn(AssistantSavedProgramDocumentService.PreparedDocuments(emptyList(), emptyMap()))
        service.answer(account, question)
        assertEquals(1, headers.size)
        assertFalse(exporter.finishedSpanItems.any { it.name == "assistant.core.resume_request" })
        server.reset()
        exporter.reset()
        expect().andRespond(withSuccess(response(true), MediaType.APPLICATION_JSON))
        `when`(documents.prepare(7L)).thenThrow(IllegalStateException("PRIVATE DOCUMENT FAILURE"))
        assertThrows(IllegalStateException::class.java) { service.answer(account, question) }
        assertEquals(setOf("assistant.total", "assistant.core.documents"), exporter.finishedSpanItems
            .filter { it.status.statusCode == StatusCode.ERROR }.map { it.name }.toSet())
    }
}
