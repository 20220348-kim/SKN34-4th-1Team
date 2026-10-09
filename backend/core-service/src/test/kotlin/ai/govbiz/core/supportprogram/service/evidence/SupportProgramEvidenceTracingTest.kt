package ai.govbiz.core.supportprogram.service.evidence

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramEvidenceClient
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.facade.SupportProgramSourceDocumentFacade
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramEvidenceTracingHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mockito
import org.mockito.Mockito.`when`
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

/** DB·공식 사이트만 대역으로 두고 Service → Facade → Client HTTP를 연결한다. */
class SupportProgramEvidenceTracingTest {
    private val exporter = InMemorySpanExporter.create()
    private val provider = SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build()
    private val tracing = SupportProgramEvidenceTracingHelper(provider.get("test"))
    private val builder = RestClient.builder().baseUrl("http://ai.test")
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = builder.build()
    private val facade = AiSupportProgramEvidenceFacade(AiSupportProgramEvidenceClient(client, client), tracing)
    private val detail = Mockito.mock(SupportProgramDetailService::class.java)
    private val repository = Mockito.mock(SupportProgramRepository::class.java)
    private val source = Mockito.mock(SupportProgramSourceDocumentFacade::class.java)
    private val clock = Clock.fixed(Instant.parse("2026-09-30T03:00:00Z"), ZoneId.of("Asia/Seoul"))
    private val service = SupportProgramEvidenceService(detail, repository, source, facade, clock, tracing)
    private val program = SupportProgramTestHelper.catalogProgram("PBLN_PRIVATE").program
    private val document = SupportProgramSourceDocument(
        "BIZINFO", program.id, program.sourceUrl, "PRIVATE 원문", SupportProgramContentHashHelper.sha256("PRIVATE 원문"),
        LocalDateTime.now(clock),
    )
    private val chunk = SupportProgramEvidenceChunker.chunk(document).single()
    private val parents = mutableListOf<String>()

    private fun prepare() {
        `when`(detail.get("BIZINFO", program.id)).thenReturn(program)
        `when`(repository.findPresentSourceDocument("BIZINFO", program.id)).thenReturn(document)
    }

    private fun expect(operation: String) = server.expect(requestTo("http://ai.test/internal/v1/support-program-evidence/$operation"))
        .andExpect { request ->
            val header = request.headers.getFirst("traceparent")
            assertNotNull(header)
            assertEquals(SupportProgramEvidenceTracingHelper.currentTraceParent(), header)
            assertNull(request.headers.getFirst("baggage"))
            parents += header!!
        }

    private fun expectPipeline(fault: String? = null) {
        expect("chunks").andRespond(withSuccess("""{"indexedCount":1}""", MediaType.APPLICATION_JSON))
        if (fault == "search") {
            expect("search").andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE))
            return
        }
        expect("search").andRespond(withSuccess("""{"question":"PRIVATE question","matches":[{
            "id":"${chunk.id}","contentHash":"${chunk.contentHash}","documentId":"${chunk.documentId}","order":0,"score":0.9
        }]}""", MediaType.APPLICATION_JSON))
        if (fault == "answer") {
            expect("answers").andRespond(withStatus(HttpStatus.GATEWAY_TIMEOUT))
            return
        }
        expect("answers").andRespond(withSuccess("""{
            "answer":"PRIVATE answer","answerStatus":"ANSWERED","citationChunkIds":["${if (fault == "validate") "f".repeat(64) else chunk.id}"]
        }""", MediaType.APPLICATION_JSON))
    }

    @AfterEach
    fun close() {
        try {
            server.verify()
            assertNull(SupportProgramEvidenceTracingHelper.currentTraceParent())
            assertFalse(exporter.finishedSpanItems.toString().contains("PRIVATE"))
            assertTrue(exporter.finishedSpanItems.all { it.events.isEmpty() })
        } finally { provider.close() }
    }

    @Test
    fun oneRequestLinksThreeHttpCallsAndCacheHitDoesNotSkipValidation() {
        prepare()
        repeat(2) { expectPipeline() }
        repeat(2) { assertEquals("PRIVATE answer", service.answer("BIZINFO", program.id, "PRIVATE question").answer) }
        val spans = exporter.finishedSpanItems
        val roots = spans.filter { it.name == "evidence.total" }
        assertEquals(16, spans.size)
        assertEquals(2, roots.map { it.traceId }.toSet().size)
        roots.forEach { root ->
            assertEquals("0000000000000000", root.parentSpanId)
            assertTrue(spans.filter { it.traceId == root.traceId && it != root }.all { it.parentSpanId == root.spanId })
        }
        assertEquals(listOf("miss", "hit"), spans.filter { it.name == "evidence.core.chunk" }
            .map { it.attributes.get(AttributeKey.stringKey("langfuse.observation.metadata.cache_state")) })
        assertEquals(List(2) { "hit" }, spans.filter { it.name == "evidence.core.source" }
            .map { it.attributes.get(AttributeKey.stringKey("langfuse.observation.metadata.cache_state")) })
        assertEquals(List(2) { listOf("evidence.core.index", "evidence.core.search", "evidence.core.answer") }.flatten(),
            parents.map { header -> spans.single { "00-${it.traceId}-${it.spanId}-01" == header }.name })
        Mockito.verifyNoInteractions(source)
    }

    @ParameterizedTest
    @ValueSource(strings = ["search", "answer", "validate"])
    fun identifiesFailureStageAndDoesNotRetry(fault: String) {
        prepare()
        expectPipeline(fault)
        assertThrows(AiServiceCallException::class.java) { service.answer("BIZINFO", program.id, "PRIVATE question") }
        val failed = exporter.finishedSpanItems.filter { it.status.statusCode == StatusCode.ERROR }
        assertEquals(setOf("evidence.total", "evidence.core.$fault"), failed.map { it.name }.toSet())
        assertTrue(failed.all { it.attributes.get(AttributeKey.stringKey("langfuse.observation.status_message")) ==
            if (fault == "answer") "timeout" else "failed" })
        assertEquals(if (fault == "search") 2 else 3, parents.size)
    }

    @Test
    fun documentPreparationFailureIsRecordedBeforeAnyAiCall() {
        prepare()
        `when`(repository.findPresentSourceDocument("BIZINFO", program.id)).thenReturn(null)
        `when`(source.load(program)).thenThrow(IllegalStateException("PRIVATE source failure"))
        assertThrows(IllegalStateException::class.java) { service.answer("BIZINFO", program.id, "PRIVATE question") }
        assertEquals(setOf("evidence.total", "evidence.core.source"), exporter.finishedSpanItems
            .filter { it.status.statusCode == StatusCode.ERROR }.map { it.name }.toSet())
        assertTrue(parents.isEmpty())
    }

    @Test
    fun preparationOutsideEvidenceQuestionDoesNotCreateAnIndependentCoreTrace() {
        prepare()
        service.prepareChunks(program)
        tracing.observe("core.index") { assertNull(SupportProgramEvidenceTracingHelper.currentTraceParent()) }
        assertTrue(exporter.finishedSpanItems.isEmpty())
    }
}
