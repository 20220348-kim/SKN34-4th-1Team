package ai.govbiz.core.assistant.helper

import ai.govbiz.core._common.exception.AiServiceCallException
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AssistantTracingHelperTest {
    @Test
    fun concurrentRequestsIgnoreAmbientParentsAndRestoreContextAfterFailure() {
        val exporter = InMemorySpanExporter.create()
        SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build().use { provider ->
            val tracer = provider.get("test")
            val tracing = AssistantTracingHelper(tracer)
            Executors.newFixedThreadPool(4).use { pool ->
                val traces = pool.invokeAll((1..12).map { Callable {
                    val ambient = tracer.spanBuilder("ambient").startSpan()
                    try {
                        ambient.makeCurrent().use {
                            assertNull(AssistantTracingHelper.currentTraceParent())
                            var parent: String? = null
                            assertThrows(AiServiceCallException::class.java) {
                                tracing.observe("total") {
                                    parent = AssistantTracingHelper.currentTraceParent()
                                    assertFalse(parent!!.contains(ambient.spanContext.traceId))
                                    tracing.observe("core.request") { throw AiServiceCallException.timeout(null) }
                                }
                            }
                            assertNull(AssistantTracingHelper.currentTraceParent())
                            assertEquals(ambient.spanContext, io.opentelemetry.api.trace.Span.current().spanContext)
                            parent
                        }
                    } finally { ambient.end() }
                } }).map { it.get() }
                assertEquals(12, traces.toSet().size)
            }
            val spans = exporter.finishedSpanItems
            assertEquals(36, spans.size)
            spans.filter { it.name == "assistant.core.request" }.forEach { child ->
                val root = spans.single { it.name == "assistant.total" && it.traceId == child.traceId }
                assertEquals(root.spanId, child.parentSpanId)
                assertEquals("0000000000000000", root.parentSpanId)
            }
        }
    }
}
