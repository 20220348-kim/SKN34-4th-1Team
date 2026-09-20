package ai.govbiz.core._health_ai_service.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core._health_ai_service.client.AiServiceHealthClient
import ai.govbiz.core._health_ai_service.client.dto.AiServiceHealthPayload
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.util.stream.Stream
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import org.mockito.Mock
import org.mockito.Mockito
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class AiServiceHealthServiceTest {

    @Mock
    private lateinit var client: AiServiceHealthClient

    private lateinit var service: AiServiceHealthService

    @BeforeEach
    fun setUp() {
        service = AiServiceHealthService(client)
    }

    @Test
    fun mapsValidatedPayloadToApplicationResult() {
        Mockito.doReturn(AiServiceHealthPayload("up", "govbiz-ai-service"))
            .`when`(client)
            .getHealth()

        val result = service.getHealth()

        assertEquals("up", result.status)
        assertEquals("govbiz-ai-service", result.service)
    }

    @ParameterizedTest
    @MethodSource("invalidPayloads")
    fun rejectsMissingOrUnexpectedLiteralValues(payload: AiServiceHealthPayload) {
        Mockito.doReturn(payload).`when`(client).getHealth()

        val exception = assertThrows(AiServiceCallException::class.java) {
            service.getHealth()
        }

        assertEquals(AiServiceFailure.INVALID_RESPONSE, exception.failure)
    }

    @ParameterizedTest
    @MethodSource("clientFailures")
    fun propagatesClientFailure(
        clientException: AiServiceCallException,
        expectedFailure: AiServiceFailure,
    ) {
        Mockito.doThrow(clientException).`when`(client).getHealth()

        val exception = assertThrows(AiServiceCallException::class.java) {
            service.getHealth()
        }

        assertEquals(expectedFailure, exception.failure)
        assertSame(clientException, exception)
    }

    private companion object {
        @JvmStatic
        fun invalidPayloads(): Stream<AiServiceHealthPayload> =
            Stream.of(
                AiServiceHealthPayload(null, "govbiz-ai-service"),
                AiServiceHealthPayload("up", null),
                AiServiceHealthPayload("down", "govbiz-ai-service"),
                AiServiceHealthPayload("up", "another-service"),
            )

        @JvmStatic
        fun clientFailures(): Stream<Arguments> =
            Stream.of(
                Arguments.of(
                    AiServiceCallException.upstreamError(
                        "unexpected status",
                        IllegalStateException("test"),
                    ),
                    AiServiceFailure.UPSTREAM_ERROR,
                ),
                Arguments.of(
                    AiServiceCallException.invalidResponse(
                        "invalid response",
                        IllegalArgumentException("test"),
                    ),
                    AiServiceFailure.INVALID_RESPONSE,
                ),
                Arguments.of(
                    AiServiceCallException.unavailable(ConnectException("test")),
                    AiServiceFailure.UNAVAILABLE,
                ),
                Arguments.of(
                    AiServiceCallException.timeout(SocketTimeoutException("test")),
                    AiServiceFailure.TIMEOUT,
                ),
            )
    }
}
