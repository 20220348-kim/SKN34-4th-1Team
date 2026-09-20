package ai.govbiz.core._common.ai_config

import ai.govbiz.core._health_ai_service.client.AiServiceHealthClient
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramConversationClient
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramEvidenceClient
import ai.govbiz.core.supportprogram.client.ai.HttpAiSupportProgramRankingClient
import java.lang.reflect.InvocationTargetException
import java.net.URI
import java.time.Duration
import java.util.function.Supplier
import java.util.stream.Stream
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.test.util.ReflectionTestUtils
import org.springframework.web.client.RestClient

class AiServiceClientPropertiesTest {

    @ParameterizedTest
    @ValueSource(
        strings = [
            "http://127.0.0.1:8000",
            "https://ai-service.internal/",
            "http://ai-service.internal:1",
            "http://ai-service.internal:65535",
        ],
    )
    fun acceptsHttpUrisAndPositiveDurations(baseUrl: String) {
        val properties = AiServiceClientProperties(
            URI.create(baseUrl),
            CONNECT_TIMEOUT,
            READ_TIMEOUT,
        )

        assertEquals(URI.create(baseUrl), properties.baseUrl)
        assertEquals(CONNECT_TIMEOUT, properties.connectTimeout)
        assertEquals(READ_TIMEOUT, properties.readTimeout)
        assertEquals(Duration.ofSeconds(30), properties.semanticSearchReadTimeout)
        assertEquals(Duration.ofSeconds(55), properties.rankingReadTimeout)
        assertEquals(Duration.ofSeconds(75), properties.combinationReviewReadTimeout)
    }

    @ParameterizedTest
    @ValueSource(
        strings = [
            "ftp://ai-service.internal:8000",
            "http:///internal/v1/health",
            "http://ai-service.internal:8000/base",
            "http://user:password@ai-service.internal:8000",
            "http://ai-service.internal:8000?debug=true",
            "http://ai-service.internal:8000#health",
            "http://ai-service.internal:0",
            "http://ai-service.internal:65536",
        ],
    )
    fun rejectsUnsupportedOrUnsafeBaseUris(baseUrl: String) {
        assertThrows(IllegalArgumentException::class.java) {
            AiServiceClientProperties(
                URI.create(baseUrl),
                CONNECT_TIMEOUT,
                READ_TIMEOUT,
            )
        }
    }

    @ParameterizedTest
    @ValueSource(
        strings = [
            "http://ai-service.internal:0",
            "http://ai-service.internal:65536",
        ],
    )
    fun rejectsOutOfRangePortsWhenApplicationContextStarts(baseUrl: String) {
        ApplicationContextRunner()
            .withUserConfiguration(AiServiceClientConfig::class.java)
            .withBean(
                RestClient.Builder::class.java,
                Supplier { RestClient.builder() },
            )
            .withPropertyValues(
                "app.ai-service.base-url=$baseUrl",
                "app.ai-service.connect-timeout=1s",
                "app.ai-service.read-timeout=2s",
            )
            .run { context ->
                val startupFailure = context.startupFailure
                assertNotNull(startupFailure)

                val cause = rootCause(startupFailure!!)
                assertInstanceOf(IllegalArgumentException::class.java, cause)
                assertTrue(cause.message.orEmpty().contains("port must be between 1 and 65535"))
            }
    }

    @ParameterizedTest
    @MethodSource("nonPositiveTimeouts")
    fun rejectsZeroOrNegativeTimeouts(connectTimeout: Duration, readTimeout: Duration) {
        assertThrows(IllegalArgumentException::class.java) {
            AiServiceClientProperties(
                URI.create("http://127.0.0.1:8000"),
                connectTimeout,
                readTimeout,
            )
        }
    }

    @Test
    fun rejectsNonPositiveSemanticSearchTimeout() {
        for (timeout in listOf(Duration.ZERO, Duration.ofSeconds(-1))) {
            assertThrows(IllegalArgumentException::class.java) {
                AiServiceClientProperties(URI.create("http://127.0.0.1:8000"), CONNECT_TIMEOUT, READ_TIMEOUT, timeout)
            }
        }
    }

    @Test
    fun rejectsNonPositiveRankingTimeout() {
        for (timeout in listOf(Duration.ZERO, Duration.ofMillis(-1))) {
            assertThrows(IllegalArgumentException::class.java) {
                AiServiceClientProperties(URI.create("http://127.0.0.1:8000"), CONNECT_TIMEOUT, READ_TIMEOUT, rankingReadTimeout = timeout)
            }
        }
    }

    @Test
    fun rejectsNonPositiveCombinationReviewTimeout() {
        for (timeout in listOf(Duration.ZERO, Duration.ofMillis(-1))) {
            assertThrows(IllegalArgumentException::class.java) {
                AiServiceClientProperties(
                    URI.create("http://127.0.0.1:8000"), CONNECT_TIMEOUT, READ_TIMEOUT,
                    combinationReviewReadTimeout = timeout,
                )
            }
        }
    }

    @Test
    fun bindsRankingTimeoutIndependentlyAndInjectsItsDedicatedBeanOnlyIntoRanking() {
        ApplicationContextRunner()
            .withUserConfiguration(
                AiServiceClientConfig::class.java, HttpAiSupportProgramRankingClient::class.java,
                AiServiceHealthClient::class.java, AiSupportProgramConversationClient::class.java,
                AiSupportProgramEvidenceClient::class.java,
            )
            .withBean(RestClient.Builder::class.java, Supplier { RestClient.builder() })
            .withPropertyValues(
                "app.ai-service.base-url=http://127.0.0.1:8000",
                "app.ai-service.connect-timeout=1s",
                "app.ai-service.read-timeout=35s",
                "app.ai-service.ranking-read-timeout=75s",
                "app.ai-service.combination-review-read-timeout=90s",
            )
            .run { context ->
                val properties = context.getBean(AiServiceClientProperties::class.java)
                assertEquals(Duration.ofSeconds(75), properties.rankingReadTimeout)
                assertEquals(Duration.ofSeconds(35), properties.readTimeout)
                assertEquals(Duration.ofSeconds(30), properties.semanticSearchReadTimeout)
                assertEquals(Duration.ofSeconds(90), properties.combinationReviewReadTimeout)
                val ranking = context.getBean("aiRankingRestClient", RestClient::class.java)
                val shared = context.getBean("aiServiceRestClient", RestClient::class.java)
                val semantic = context.getBean("aiSemanticSearchRestClient", RestClient::class.java)
                val combination = context.getBean("aiCombinationReviewRestClient", RestClient::class.java)
                assertNotSame(ranking, shared)
                assertNotSame(ranking, semantic)
                assertNotSame(combination, shared)
                assertNotSame(combination, ranking)
                assertNotSame(combination, semantic)
                assertSame(ranking, ReflectionTestUtils.getField(context.getBean(HttpAiSupportProgramRankingClient::class.java), "restClient"))
                assertSame(shared, ReflectionTestUtils.getField(context.getBean(AiServiceHealthClient::class.java), "restClient"))
                assertSame(shared, ReflectionTestUtils.getField(context.getBean(AiSupportProgramConversationClient::class.java), "restClient"))
                assertSame(shared, ReflectionTestUtils.getField(context.getBean(AiSupportProgramEvidenceClient::class.java), "answerRestClient"))
                assertSame(semantic, ReflectionTestUtils.getField(context.getBean(AiSupportProgramEvidenceClient::class.java), "semanticSearchRestClient"))
            }
    }

    @Test
    fun rejectsMissingRequiredValues() {
        assertConstructorRejectsNull(null, CONNECT_TIMEOUT, READ_TIMEOUT)
        assertConstructorRejectsNull(
            URI.create("http://127.0.0.1:8000"),
            null,
            READ_TIMEOUT,
        )
        assertConstructorRejectsNull(
            URI.create("http://127.0.0.1:8000"),
            CONNECT_TIMEOUT,
            null,
        )
        assertConstructorRejectsNull(URI.create("http://127.0.0.1:8000"), CONNECT_TIMEOUT, READ_TIMEOUT, null)
        assertConstructorRejectsNull(
            URI.create("http://127.0.0.1:8000"), CONNECT_TIMEOUT, READ_TIMEOUT,
            combinationReviewReadTimeout = null,
        )
    }

    @Test fun discoveryReadTimeoutMustFitInsideWorkerLease() {
        assertThrows(IllegalArgumentException::class.java) {
            AiServiceClientProperties(URI.create("http://ai.test"), CONNECT_TIMEOUT, READ_TIMEOUT,
                applicationFormDiscoveryReadTimeout=Duration.ofSeconds(300), applicationFormWorkerLease=Duration.ofSeconds(300))
        }
        val properties = AiServiceClientProperties(URI.create("http://ai.test"), CONNECT_TIMEOUT, READ_TIMEOUT)
        assertEquals(Duration.ofSeconds(270), properties.applicationFormDiscoveryReadTimeout)
        assertEquals(Duration.ofSeconds(1800), properties.applicationFormWorkerLease)
        assertEquals(READ_TIMEOUT, properties.readTimeout)
    }

    private fun assertConstructorRejectsNull(
        baseUrl: URI?,
        connectTimeout: Duration?,
        readTimeout: Duration?,
        rankingReadTimeout: Duration? = Duration.ofSeconds(55),
        combinationReviewReadTimeout: Duration? = Duration.ofSeconds(75),
    ) {
        val constructor = AiServiceClientProperties::class.java.getDeclaredConstructor(
            URI::class.java,
            Duration::class.java,
            Duration::class.java,
            Duration::class.java,
            Duration::class.java,
            Duration::class.java,
            Duration::class.java,
            Duration::class.java,
        )
        val exception = assertThrows(InvocationTargetException::class.java) {
            constructor.newInstance(
                baseUrl, connectTimeout, readTimeout, Duration.ofSeconds(30), rankingReadTimeout,
                combinationReviewReadTimeout, Duration.ofSeconds(270), Duration.ofSeconds(1800),
            )
        }
        assertInstanceOf(
            NullPointerException::class.java,
            requireNotNull(exception.cause),
        )
    }

    private fun rootCause(throwable: Throwable): Throwable {
        var current = throwable
        while (current.cause != null) {
            current = current.cause!!
        }
        return current
    }

    private companion object {
        val CONNECT_TIMEOUT: Duration = Duration.ofSeconds(1)
        val READ_TIMEOUT: Duration = Duration.ofSeconds(2)

        @JvmStatic
        fun nonPositiveTimeouts(): Stream<Arguments> =
            Stream.of(
                Arguments.of(Duration.ZERO, READ_TIMEOUT),
                Arguments.of(Duration.ofMillis(-1), READ_TIMEOUT),
                Arguments.of(CONNECT_TIMEOUT, Duration.ZERO),
                Arguments.of(CONNECT_TIMEOUT, Duration.ofMillis(-1)),
            )
    }
}
