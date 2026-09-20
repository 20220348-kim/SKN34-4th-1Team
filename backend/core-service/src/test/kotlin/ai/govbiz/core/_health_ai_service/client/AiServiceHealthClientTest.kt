package ai.govbiz.core._health_ai_service.client

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.http.HttpConnectTimeoutException
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.ResponseCreator
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withException
import org.springframework.test.web.client.response.MockRestResponseCreators.withNoContent
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class AiServiceHealthClientTest {

    private lateinit var server: MockRestServiceServer
    private lateinit var client: AiServiceHealthClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder()
            .baseUrl(BASE_URL)
            .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
        server = MockRestServiceServer.bindTo(builder).build()
        client = AiServiceHealthClient(builder.build())
    }

    @AfterEach
    fun verifiesEveryExpectedRequest() {
        server.verify()
    }

    @Test
    fun sendsExactHealthRequestAndDecodesValidJson() {
        server.expect(requestTo(HEALTH_URL))
            .andExpect(method(HttpMethod.GET))
            .andExpect(header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE))
            .andRespond(withSuccess(VALID_RESPONSE, MediaType.APPLICATION_JSON))

        val response = client.getHealth()

        assertEquals("up", response.status)
        assertEquals("govbiz-ai-service", response.service)
    }

    @Test
    fun mapsDownstream4xxToUpstreamError() {
        expectResponse(
            withStatus(HttpStatus.NOT_FOUND)
                .contentType(MediaType.TEXT_PLAIN)
                .body("not-json"),
        )

        assertFailure(AiServiceFailure.UPSTREAM_ERROR)
    }

    @Test
    fun mapsDownstream503ToUnavailable() {
        expectResponse(
            withStatus(HttpStatus.SERVICE_UNAVAILABLE)
                .contentType(MediaType.TEXT_PLAIN)
                .body("not-json"),
        )

        assertFailure(AiServiceFailure.UNAVAILABLE)
    }

    @Test
    fun mapsOtherDownstream5xxToUpstreamError() {
        expectResponse(
            withStatus(HttpStatus.INTERNAL_SERVER_ERROR)
                .contentType(MediaType.TEXT_PLAIN)
                .body("not-json"),
        )

        assertFailure(AiServiceFailure.UPSTREAM_ERROR)
    }

    @Test
    fun mapsUnexpectedSuccessfulStatusToUpstreamError() {
        expectResponse(
            withStatus(HttpStatus.CREATED)
                .contentType(MediaType.TEXT_PLAIN)
                .body("not-json"),
        )

        assertFailure(AiServiceFailure.UPSTREAM_ERROR)
    }

    @Test
    fun mapsRedirectStatusToUpstreamErrorWithoutDecodingBody() {
        expectResponse(
            withStatus(HttpStatus.FOUND)
                .contentType(MediaType.TEXT_PLAIN)
                .body("not-json"),
        )

        assertFailure(AiServiceFailure.UPSTREAM_ERROR)
    }

    @Test
    fun mapsNoContentToInvalidResponse() {
        expectResponse(withNoContent())

        assertFailure(AiServiceFailure.INVALID_RESPONSE)
    }

    @Test
    fun mapsEmptySuccessBodyToInvalidResponse() {
        expectResponse(withSuccess("", MediaType.APPLICATION_JSON))

        assertFailure(AiServiceFailure.INVALID_RESPONSE)
    }

    @Test
    fun mapsWrongContentTypeToInvalidResponse() {
        expectResponse(withSuccess(VALID_RESPONSE, MediaType.TEXT_PLAIN))

        assertFailure(AiServiceFailure.INVALID_RESPONSE)
    }

    @Test
    fun mapsMalformedJsonToInvalidResponse() {
        expectResponse(withSuccess("{\"status\":", MediaType.APPLICATION_JSON))

        assertFailure(AiServiceFailure.INVALID_RESPONSE)
    }

    @Test
    fun mapsConnectionFailureToUnavailable() {
        expectResponse(withException(ConnectException("connection refused")))

        assertFailure(AiServiceFailure.UNAVAILABLE)
    }

    @Test
    fun mapsConnectTimeoutToTimeout() {
        expectResponse(withException(HttpConnectTimeoutException("connect timeout")))

        assertFailure(AiServiceFailure.TIMEOUT)
    }

    @Test
    fun mapsReadTimeoutToTimeout() {
        expectResponse(withException(SocketTimeoutException("read timeout")))

        assertFailure(AiServiceFailure.TIMEOUT)
    }

    private fun expectResponse(response: ResponseCreator) {
        server.expect(requestTo(HEALTH_URL)).andRespond(response)
    }

    private fun assertFailure(expectedFailure: AiServiceFailure) {
        val exception = assertThrows(AiServiceCallException::class.java) {
            client.getHealth()
        }
        assertEquals(expectedFailure, exception.failure)
    }

    private companion object {
        const val BASE_URL = "http://ai-service.test:8000"
        const val HEALTH_URL = "$BASE_URL/internal/v1/health"
        val VALID_RESPONSE =
            """
            {"status":"up","service":"govbiz-ai-service"}
            """.trimIndent()
    }
}
