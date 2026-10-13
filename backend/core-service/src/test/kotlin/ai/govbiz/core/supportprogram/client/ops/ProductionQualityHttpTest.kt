package ai.govbiz.core.supportprogram.client.ops

import ai.govbiz.core.supportprogram.client.ops.config.ProductionQualityProperties
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityChunkRequest
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityMaterialRequest
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.AppenderBase
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.http.HttpClient
import java.time.Duration
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.slf4j.LoggerFactory
import tools.jackson.module.kotlin.jacksonObjectMapper

/** 실제 JDK HTTP 전송만 검증한다. Ops DB나 모델을 호출하지 않는다. */
class ProductionQualityHttpTest {
    @Test
    fun acceptsAnAcknowledgementDelayedBeyondTheOldTwoSecondLimit() {
        DelayedReceiver(Duration.ofSeconds(15)).use { receiver ->
            receiver.record()
            assertTrue(receiver.received.await(3, TimeUnit.SECONDS))
            assertFalse(receiver.outcome.await(2500, TimeUnit.MILLISECONDS), "2초를 넘어도 응답을 계속 기다려야 한다")
            receiver.respond.countDown()
            assertTrue(receiver.outcome.await(3, TimeUnit.SECONDS))
            val log = receiver.logs.single()
            assertTrue(log.startsWith("production_quality_sample_accepted sample_id=${receiver.sampleId} "))
            assertTrue(log.contains("status=201"))
            assertEquals(1, receiver.requests.get())
        }
    }

    @Test
    fun reportsUnknownDeliveryWhenTheServerReceivedTheSampleButHasNotAcknowledgedIt() {
        DelayedReceiver(Duration.ofSeconds(1)).use { receiver ->
            receiver.record()
            assertTrue(receiver.received.await(3, TimeUnit.SECONDS))
            assertTrue(receiver.outcome.await(3, TimeUnit.SECONDS))
            val log = receiver.logs.single()
            assertTrue(log.startsWith("production_quality_sample_delivery_unknown reason=timeout sample_id=${receiver.sampleId} "))
            assertFalse(log.contains("status="))
            assertEquals(1, receiver.requests.get(), "응답 불명 상태에서 자동 재전송하지 않는다")
        }
    }

    private class DelayedReceiver(timeout: Duration) : AutoCloseable {
        val received = CountDownLatch(1)
        val respond = CountDownLatch(1)
        val outcome = CountDownLatch(1)
        val requests = AtomicInteger()
        val logs = ConcurrentLinkedQueue<String>()
        var sampleId = ""
        private val mapper = jacksonObjectMapper()
        private val logger = LoggerFactory.getLogger(ProductionQualityClient::class.java) as Logger
        private val appender = object : AppenderBase<ILoggingEvent>() {
            override fun append(event: ILoggingEvent) {
                logs.add(event.formattedMessage)
                outcome.countDown()
            }
        }.also { it.start(); logger.addAppender(it) }
        private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { server ->
            server.createContext("/internal/llmops/production-samples") { exchange ->
                try {
                    sampleId = mapper.readTree(exchange.requestBody.readAllBytes())["id"].asText()
                    requests.incrementAndGet()
                    received.countDown()
                    if (respond.await(10, TimeUnit.SECONDS)) exchange.sendResponseHeaders(201, -1)
                } finally {
                    exchange.close()
                }
            }
            server.start()
        }
        private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()
        private val client = ProductionQualityClient(
            ProductionQualityProperties(
                rateBps = 10_000,
                baseUrl = "http://127.0.0.1:${server.address.port}",
                token = "local-test-only-token-".repeat(2),
                requestTimeout = timeout,
            ), mapper, http,
        )

        fun record() {
            val chunk = ProductionQualityChunkRequest("a".repeat(64), "BIZINFO:LOCAL_TEST", 0, "온라인 신청")
            client.record(ProductionQualityMaterialRequest("신청 방법은?", listOf(chunk), "온라인 신청", "ANSWERED", listOf(chunk.id)), null)
        }

        override fun close() {
            respond.countDown()
            http.shutdownNow()
            server.stop(0)
            logger.detachAppender(appender)
            appender.stop()
        }
    }
}
