package ai.govbiz.core._health_ai_service.controller

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core._health_ai_service.client.AiServiceHealthClient
import ai.govbiz.core._health_ai_service.client.dto.AiServiceHealthPayload
import ai.govbiz.core._health_ai_service.service.AiServiceHealthService
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.util.stream.Stream
import org.hamcrest.Matchers.containsString
import org.hamcrest.Matchers.not
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import org.mockito.Mock
import org.mockito.Mockito
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class AiServiceHealthControllerTest {

    @Mock
    private lateinit var client: AiServiceHealthClient

    private lateinit var mockMvc: MockMvc

    @BeforeEach
    fun setUp() {
        val service = AiServiceHealthService(client)
        mockMvc = MockMvcBuilders
            .standaloneSetup(AiServiceHealthController(service))
            .setControllerAdvice(ApiExceptionHandler())
            .build()
    }

    @Test
    fun returnsPublicHealthContract() {
        Mockito.doReturn(AiServiceHealthPayload("up", "govbiz-ai-service"))
            .`when`(client)
            .getHealth()

        mockMvc.perform(get(PATH))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.status").value("up"))
            .andExpect(jsonPath("$.service").value("govbiz-ai-service"))
    }

    @ParameterizedTest
    @MethodSource("problemCases")
    fun mapsFailuresToStableProblemDetails(
        clientException: AiServiceCallException,
        expectedStatus: Int,
        expectedCode: String,
        expectedType: String,
        expectedTitle: String,
        expectedDetail: String,
    ) {
        Mockito.doThrow(clientException).`when`(client).getHealth()

        mockMvc.perform(get(PATH))
            .andExpect(status().`is`(expectedStatus))
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.status").value(expectedStatus))
            .andExpect(jsonPath("$.instance").value(PATH))
            .andExpect(jsonPath("$.code").value(expectedCode))
            .andExpect(jsonPath("$.type").value(expectedType))
            .andExpect(jsonPath("$.title").value(expectedTitle))
            .andExpect(jsonPath("$.detail").value(expectedDetail))
            .andExpect(content().string(not(containsString("AI Service returned HTTP 503"))))
            .andExpect(content().string(not(containsString("invalid JSON"))))
            .andExpect(content().string(not(containsString("do not expose this"))))
            .andExpect(content().string(not(containsString("internal timeout"))))
            .andExpect(content().string(not(containsString("127.0.0.1"))))
            .andExpect(content().string(not(containsString("8000"))))
    }

    private companion object {
        const val PATH = "/api/v1/health/ai-service"

        @JvmStatic
        fun problemCases(): Stream<Arguments> =
            Stream.of(
                Arguments.of(
                    AiServiceCallException.upstreamError(
                        "AI Service returned HTTP 503",
                        IllegalStateException("do not expose this"),
                    ),
                    502,
                    "AI_SERVICE_UPSTREAM_ERROR",
                    "urn:govbiz:problem:ai-service-upstream-error",
                    "AI Service Upstream Error",
                    "AI Service returned an unexpected HTTP status.",
                ),
                Arguments.of(
                    AiServiceCallException.invalidResponse(
                        "invalid JSON",
                        IllegalArgumentException("do not expose this"),
                    ),
                    502,
                    "AI_SERVICE_INVALID_RESPONSE",
                    "urn:govbiz:problem:ai-service-invalid-response",
                    "AI Service Invalid Response",
                    "AI Service returned an invalid response.",
                ),
                Arguments.of(
                    AiServiceCallException.unavailable(
                        ConnectException("127.0.0.1:8000"),
                    ),
                    503,
                    "AI_SERVICE_UNAVAILABLE",
                    "urn:govbiz:problem:ai-service-unavailable",
                    "AI Service Unavailable",
                    "AI Service is currently unavailable.",
                ),
                Arguments.of(
                    AiServiceCallException.timeout(
                        SocketTimeoutException("internal timeout"),
                    ),
                    504,
                    "AI_SERVICE_TIMEOUT",
                    "urn:govbiz:problem:ai-service-timeout",
                    "AI Service Gateway Timeout",
                    "AI Service did not respond within the configured timeout.",
                ),
            )
    }
}
