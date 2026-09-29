package ai.govbiz.core._common.config

import ai.govbiz.core.assistant.helper.AssistantTracingHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramEvidenceTracingHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramSearchTracingHelper
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.Base64
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.mock.env.MockEnvironment

class LlmTracingConfigTest {
    @Test
    fun exportsToLangfuseOtlpEndpointAndIsolatesIngestionFailure() {
        val received = LinkedBlockingQueue<Pair<String?, ByteArray>>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/public/otel/v1/traces") { exchange ->
            received.add(exchange.requestHeaders.getFirst("Authorization") to exchange.requestBody.readAllBytes())
            // 실제 HTTP 전송 실패도 업무 결과를 바꾸거나 업무를 재실행하지 않는다.
            exchange.sendResponseHeaders(400, -1)
            exchange.close()
        }
        server.start()
        try {
            val config = LlmTracingConfig()
            val environment = MockEnvironment()
                .withProperty("LANGFUSE_ENABLED", "true")
                .withProperty("LANGFUSE_BASE_URL", "http://127.0.0.1:${server.address.port}")
                .withProperty("LANGFUSE_PUBLIC_KEY", "pk-local-test")
                .withProperty("LANGFUSE_SECRET_KEY", "sk-local-test")
            config.llmTracerProvider(environment).use { provider ->
                val tracing = config.supportProgramSearchTracingHelper(provider, environment)
                var calls = 0
                assertEquals("selected", tracing.observe("total") { calls++; "selected" })
                assertEquals("answered", config.assistantTracingHelper(provider, environment).observe("total") { calls++; "answered" })
                assertEquals("evidence", config.supportProgramEvidenceTracingHelper(provider, environment).observe("total") { calls++; "evidence" })
                provider.forceFlush().join(5, TimeUnit.SECONDS)
                val request = received.poll(5, TimeUnit.SECONDS)
                assertNotNull(request)
                assertEquals("Basic " + Base64.getEncoder().encodeToString("pk-local-test:sk-local-test".toByteArray()), request.first)
                assertTrue(request.second.isNotEmpty())
                assertEquals(3, calls)
                assertNull(AssistantTracingHelper.currentTraceParent())
                assertNull(SupportProgramSearchTracingHelper.currentTraceParent())
                assertNull(SupportProgramEvidenceTracingHelper.currentTraceParent())
            }
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun disabledTracingNeedsNoKeysAndDoesNotPropagateParent() {
        val config = LlmTracingConfig()
        val environment = MockEnvironment()
        config.llmTracerProvider(environment).use { provider ->
            config.supportProgramSearchTracingHelper(provider, environment).observe("total") {
                assertNull(SupportProgramSearchTracingHelper.currentTraceParent())
            }
            config.assistantTracingHelper(provider, environment).observe("total") {
                assertNull(AssistantTracingHelper.currentTraceParent())
            }
            config.supportProgramEvidenceTracingHelper(provider, environment).observe("total") {
                assertNull(SupportProgramEvidenceTracingHelper.currentTraceParent())
            }
        }
    }

    @Test
    fun rejectsUnsafeConfigurationWithoutEchoingItsValue() {
        for (url in listOf("http://user:PRIVATE@localhost", "http://localhost/PRIVATE", "http://PRIVATE invalid")) {
            val error = assertThrows(IllegalArgumentException::class.java) {
                LlmTracingConfig().llmTracerProvider(MockEnvironment()
                    .withProperty("LANGFUSE_ENABLED", "true").withProperty("LANGFUSE_BASE_URL", url))
            }
            assertEquals("Invalid LANGFUSE_BASE_URL", error.message)
            assertNull(error.cause)
        }
    }
}
