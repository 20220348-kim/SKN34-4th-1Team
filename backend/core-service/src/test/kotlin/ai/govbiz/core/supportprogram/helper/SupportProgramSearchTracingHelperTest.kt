package ai.govbiz.core.supportprogram.helper

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramIndexClient
import ai.govbiz.core.supportprogram.client.ai.HttpAiSupportProgramRankingClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexSearchRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.web.client.RestClient

class SupportProgramSearchTracingHelperTest {
    @Test
    fun isolatesConcurrentSearchesAndCleansUpContextAfterFailure() {
        val exporter = InMemorySpanExporter.create()
        SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build().use { provider ->
            val tracing = SupportProgramSearchTracingHelper(provider.get("test"))
            Executors.newFixedThreadPool(4).use { executor ->
                val parents = executor.invokeAll((1..12).map { Callable {
                    tracing.observe("total") {
                        val parent = SupportProgramSearchTracingHelper.currentTraceParent()
                        assertThrows(AiServiceCallException::class.java) {
                            tracing.observe("ranking") { throw AiServiceCallException.timeout(RuntimeException("PRIVATE QUESTION")) }
                        }
                        assertEquals(parent, SupportProgramSearchTracingHelper.currentTraceParent())
                        parent
                    }.also { assertNull(SupportProgramSearchTracingHelper.currentTraceParent()) }
                } }).map { it.get() }
                assertEquals(12, parents.toSet().size)
            }
            val spans = exporter.finishedSpanItems
            assertEquals(24, spans.size)
            spans.filter { it.name == "search.ranking" }.forEach { child ->
                val root = spans.single { it.name == "search.total" && it.traceId == child.traceId }
                assertEquals(root.spanId, child.parentSpanId)
                assertEquals(StatusCode.ERROR, child.status.statusCode)
                assertEquals("timeout", child.attributes.get(AttributeKey.stringKey("langfuse.observation.status_message")))
                assertTrue(child.events.isEmpty())
            }
            assertFalse(spans.toString().contains("PRIVATE QUESTION"))
        }
    }

    @Test
    fun propagatesOnlyActiveSearchParentToBothAiClients() {
        val exporter = InMemorySpanExporter.create()
        SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build().use { provider ->
            val tracing = SupportProgramSearchTracingHelper(provider.get("test"))
            val builder = RestClient.builder().baseUrl("http://ai.test")
            val server = MockRestServiceServer.bindTo(builder).build()
            val client = builder.build()
            for (path in listOf("support-program-index/search", "support-program-rankings/rank")) {
                server.expect(requestTo("http://ai.test/internal/v1/$path"))
                    .andExpect { request -> assertEquals(SupportProgramSearchTracingHelper.currentTraceParent(), request.headers.getFirst("traceparent")) }
                    .andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE))
            }
            tracing.observe("total") {
                for (path in listOf("support-program-index/search", "support-program-rankings/rank")) {
                    tracing.observe("retrieval") {
                        assertThrows(AiServiceCallException::class.java) {
                            if (path.contains("index")) AiSupportProgramIndexClient(client).search(AiSupportProgramIndexSearchRequest("private", emptyList(), 20))
                            else HttpAiSupportProgramRankingClient(client).rankSupportPrograms(AiSupportProgramRankingRequest("private", "v1", 5, emptyList()))
                        }
                    }
                }
            }
            server.verify()
            assertNull(SupportProgramSearchTracingHelper.currentTraceParent())
        }
    }
}
