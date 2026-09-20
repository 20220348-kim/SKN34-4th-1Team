package ai.govbiz.core._common.ai_config

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core._health_ai_service.client.AiServiceHealthClient
import ai.govbiz.core.combinationreview.client.AiCombinationReviewClient
import ai.govbiz.core.supportprogram.client.ai.HttpAiSupportProgramRankingClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.URI
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTimeout
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.web.client.RestClient

class AiServiceClientConfigIntegrationTest {

    private lateinit var server: HttpServer
    private lateinit var serverExecutor: ExecutorService

    @BeforeEach
    fun setUpServer() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        serverExecutor = Executors.newCachedThreadPool { runnable ->
            Thread(runnable, "ai-service-config-test-server").apply {
                isDaemon = true
            }
        }
        server.executor = serverExecutor
    }

    @AfterEach
    fun stopServerAndExecutor() {
        server.stop(0)
        serverExecutor.shutdownNow()
        assertTrue(
            serverExecutor.awaitTermination(2, TimeUnit.SECONDS),
            "local HTTP test server threads must terminate",
        )
    }

    @Test
    fun usesHttp11WithoutAttemptingH2cUpgrade() {
        val protocol = AtomicReference<String?>()
        val upgradeHeader = AtomicReference<String?>()
        val http2SettingsHeader = AtomicReference<String?>()
        val acceptHeader = AtomicReference<String?>()

        server.createContext(HEALTH_PATH) { exchange ->
            protocol.set(exchange.protocol)
            upgradeHeader.set(exchange.requestHeaders.getFirst("Upgrade"))
            http2SettingsHeader.set(exchange.requestHeaders.getFirst("HTTP2-Settings"))
            acceptHeader.set(exchange.requestHeaders.getFirst(HttpHeaders.ACCEPT))
            sendJson(exchange, VALID_RESPONSE)
        }
        server.start()

        // 프로토콜 검증에 최초 JSON 클래스 로딩의 1초 제한을 섞지 않고 운영 기본 상한을 사용합니다.
        // 실제 read timeout 동작은 아래의 150ms 지연 응답 테스트가 별도로 검증합니다.
        val response = createClient(Duration.ofSeconds(35)).getHealth()

        assertAll(
            { assertEquals("up", response.status) },
            { assertEquals("govbiz-ai-service", response.service) },
            { assertEquals("HTTP/1.1", protocol.get()) },
            { assertNull(upgradeHeader.get()) },
            { assertNull(http2SettingsHeader.get()) },
            { assertEquals(MediaType.APPLICATION_JSON_VALUE, acceptHeader.get()) },
        )
    }

    @Test
    fun doesNotFollowRedirects() {
        val healthRequestCount = AtomicInteger()
        val redirectTargetRequestCount = AtomicInteger()

        server.createContext(HEALTH_PATH) { exchange ->
            healthRequestCount.incrementAndGet()
            exchange.responseHeaders.set(HttpHeaders.LOCATION, "/redirect-target")
            exchange.sendResponseHeaders(302, -1)
            exchange.close()
        }
        server.createContext("/redirect-target") { exchange ->
            redirectTargetRequestCount.incrementAndGet()
            sendJson(exchange, VALID_RESPONSE)
        }
        server.start()

        val exception = assertThrows(AiServiceCallException::class.java) {
            createClient(Duration.ofSeconds(1)).getHealth()
        }

        assertAll(
            {
                assertEquals(
                    AiServiceFailure.UPSTREAM_ERROR,
                    exception.failure,
                )
            },
            { assertEquals(1, healthRequestCount.get()) },
            { assertEquals(0, redirectTargetRequestCount.get()) },
        )
    }

    @Test
    fun appliesConfiguredReadTimeoutToARealRequest() {
        val requestReceived = CountDownLatch(1)

        server.createContext(HEALTH_PATH) { exchange ->
            requestReceived.countDown()
            try {
                Thread.sleep(Duration.ofSeconds(2).toMillis())
                sendJson(exchange, VALID_RESPONSE)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                exchange.close()
            }
        }
        server.start()

        val exception = assertTimeout<AiServiceCallException>(Duration.ofSeconds(3)) {
            assertThrows(AiServiceCallException::class.java) {
                createClient(Duration.ofMillis(150)).getHealth()
            }
        }

        assertAll(
            { assertEquals(AiServiceFailure.TIMEOUT, exception.failure) },
            { assertEquals(0L, requestReceived.count) },
        )
    }

    @Test
    fun appliesTheRankingSpecificReadTimeoutInsteadOfTheSharedTimeout() {
        val requestReceived = CountDownLatch(1)
        server.createContext("/internal/v1/support-program-rankings/rank") { exchange ->
            requestReceived.countDown()
            try {
                Thread.sleep(Duration.ofSeconds(2).toMillis())
                sendJson(exchange, """{"originalQuery":"AI","scoringVersion":"govbiz-support-program-ranking-v5","rankings":[]}""")
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                exchange.close()
            }
        }
        server.start()
        val properties = AiServiceClientProperties(
            URI.create("http://127.0.0.1:${server.address.port}"), CONNECT_TIMEOUT,
            Duration.ofSeconds(35), rankingReadTimeout = Duration.ofMillis(150),
        )
        val client = HttpAiSupportProgramRankingClient(AiServiceClientConfig().aiRankingRestClient(RestClient.builder(), properties))

        val exception = assertThrows(AiServiceCallException::class.java) {
            client.rankSupportPrograms(AiSupportProgramRankingRequest("AI", "govbiz-support-program-ranking-v5", 1, emptyList()))
        }

        assertEquals(AiServiceFailure.TIMEOUT, exception.failure)
        assertEquals(0L, requestReceived.count)
    }

    @Test
    fun appliesTheCombinationReviewSpecificReadTimeoutInsteadOfTheSharedTimeout() {
        val requestReceived = CountDownLatch(1)
        server.createContext("/internal/v1/combination-reviews/configuration") { exchange ->
            requestReceived.countDown()
            try {
                Thread.sleep(Duration.ofSeconds(2).toMillis())
                sendJson(exchange, """{"contractVersion":"combination-review-v2","model":"test","promptVersion":"test"}""")
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                exchange.close()
            }
        }
        server.start()
        val properties = AiServiceClientProperties(
            URI.create("http://127.0.0.1:${server.address.port}"), CONNECT_TIMEOUT,
            Duration.ofSeconds(35), combinationReviewReadTimeout = Duration.ofMillis(150),
        )
        val client = AiCombinationReviewClient(
            AiServiceClientConfig().aiCombinationReviewRestClient(RestClient.builder(), properties),
            mock(tools.jackson.databind.ObjectMapper::class.java),
        )

        val exception = assertThrows(AiServiceCallException::class.java) { client.configuration() }

        assertEquals(AiServiceFailure.TIMEOUT, exception.failure)
        assertEquals(0L, requestReceived.count)
    }

    @Test
    fun retainsTheSemanticReadTimeoutWhenRankingHasALongerBudget() {
        val requestReceived = CountDownLatch(1)
        server.createContext(HEALTH_PATH) { exchange ->
            requestReceived.countDown()
            try {
                Thread.sleep(Duration.ofSeconds(2).toMillis())
                sendJson(exchange, VALID_RESPONSE)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                exchange.close()
            }
        }
        server.start()
        val properties = AiServiceClientProperties(
            URI.create("http://127.0.0.1:${server.address.port}"), CONNECT_TIMEOUT,
            Duration.ofSeconds(35), semanticSearchReadTimeout = Duration.ofMillis(150),
            rankingReadTimeout = Duration.ofSeconds(55),
        )
        val client = AiServiceHealthClient(AiServiceClientConfig().aiSemanticSearchRestClient(RestClient.builder(), properties))

        val exception = assertThrows(AiServiceCallException::class.java) { client.getHealth() }

        assertEquals(AiServiceFailure.TIMEOUT, exception.failure)
        assertEquals(0L, requestReceived.count)
    }

    private fun createClient(readTimeout: Duration): AiServiceHealthClient {
        val baseUrl = URI.create("http://127.0.0.1:${server.address.port}")
        val properties = AiServiceClientProperties(
            baseUrl,
            CONNECT_TIMEOUT,
            readTimeout,
        )
        val restClient = AiServiceClientConfig().aiServiceRestClient(
            RestClient.builder(),
            properties,
        )
        return AiServiceHealthClient(restClient)
    }

    private fun sendJson(exchange: HttpExchange, body: String) {
        val responseBody = body.toByteArray(StandardCharsets.UTF_8)
        exchange.responseHeaders.set(
            HttpHeaders.CONTENT_TYPE,
            MediaType.APPLICATION_JSON_VALUE,
        )
        exchange.sendResponseHeaders(200, responseBody.size.toLong())
        try {
            exchange.responseBody.use { output -> output.write(responseBody) }
        } finally {
            exchange.close()
        }
    }

    private companion object {
        const val HEALTH_PATH = "/internal/v1/health"
        val VALID_RESPONSE =
            """
            {"status":"up","service":"govbiz-ai-service"}
            """.trimIndent()
        val CONNECT_TIMEOUT: Duration = Duration.ofSeconds(1)
    }
}
