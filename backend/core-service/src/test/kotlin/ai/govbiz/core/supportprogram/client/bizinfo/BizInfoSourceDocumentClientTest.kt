package ai.govbiz.core.supportprogram.client.bizinfo

import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoSourceDocumentClientException
import java.io.ByteArrayInputStream
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.mock.http.client.MockClientHttpResponse
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withException
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class BizInfoSourceDocumentClientTest {

    private lateinit var server: MockRestServiceServer
    private lateinit var client: BizInfoSourceDocumentClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder().baseUrl(BASE_URL)
        server = MockRestServiceServer.bindTo(builder).build()
        client = BizInfoSourceDocumentClient(builder.build())
    }

    @AfterEach
    fun verifiesEveryExpectedRequest() {
        server.verify()
    }

    @Test
    fun fetchesHtmlOnlyFromTheOfficialHttpsSourceUrl() {
        server.expect(requestTo(SOURCE_URL))
            .andExpect(method(HttpMethod.GET))
            .andExpect(header(HttpHeaders.ACCEPT, MediaType.TEXT_HTML_VALUE))
            .andRespond(withSuccess(HTML, MediaType(MediaType.TEXT_HTML, StandardCharsets.UTF_8)))

        assertEquals(HTML, client.fetchHtml(SOURCE_URL, SOURCE_PROGRAM_ID))
    }

    @ParameterizedTest
    @ValueSource(ints = [301, 302, 303, 307, 308])
    fun followsAnOfficialRelativeRedirectToTheSamePublication(status: Int) {
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withStatus(HttpStatus.valueOf(status)).header(HttpHeaders.LOCATION, CURRENT_DETAIL_PATH))
        server.expect(requestTo("$BASE_URL$CURRENT_DETAIL_PATH"))
            .andExpect(method(HttpMethod.GET))
            .andExpect(header(HttpHeaders.ACCEPT, MediaType.TEXT_HTML_VALUE))
            .andRespond(withSuccess(HTML, MediaType.TEXT_HTML))

        assertEquals(HTML, client.fetchHtml(SOURCE_URL, SOURCE_PROGRAM_ID))
    }

    @Test
    fun followsAnOfficialAbsoluteRedirectToTheSamePublication() {
        val currentUrl = "$BASE_URL$CURRENT_DETAIL_PATH"
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, currentUrl))
        server.expect(requestTo(currentUrl))
            .andRespond(withSuccess(HTML, MediaType.TEXT_HTML))

        assertEquals(HTML, client.fetchHtml(SOURCE_URL, SOURCE_PROGRAM_ID))
    }

    @Test
    fun rejectsUnsafeRedirectTargetsBeforeRequestingThem() {
        val unsafeLocations = listOf(
            "http://www.bizinfo.go.kr$CURRENT_DETAIL_PATH",
            "https://example.com$CURRENT_DETAIL_PATH",
            "//www.bizinfo.go.kr.example.com$CURRENT_DETAIL_PATH",
            "https://user@www.bizinfo.go.kr$CURRENT_DETAIL_PATH",
            "https://www.bizinfo.go.kr:444$CURRENT_DETAIL_PATH",
            "/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_OTHER",
            "$CURRENT_DETAIL_PATH&pblancId=$SOURCE_PROGRAM_ID",
            "/sii/siia/selectSIIA200Detail.do",
            "not a valid URI",
            "",
        )
        unsafeLocations.forEach { location ->
            server.expect(requestTo(SOURCE_URL))
                .andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, location))
        }

        unsafeLocations.forEach { _ ->
            assertFailure(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE)
        }
    }

    @Test
    fun rejectsARedirectWithoutALocation() {
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withStatus(HttpStatus.FOUND))

        assertFailure(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun closesARedirectResponseEvenWhenItsTargetIsRejected() {
        var responseBodyClosed = false
        val responseBody = object : ByteArrayInputStream(HTML.toByteArray()) {
            override fun close() {
                responseBodyClosed = true
                super.close()
            }
        }
        server.expect(requestTo(SOURCE_URL))
            .andRespond {
                MockClientHttpResponse(responseBody, HttpStatus.FOUND).apply {
                    headers.set(HttpHeaders.LOCATION, "https://example.com$CURRENT_DETAIL_PATH")
                }
            }

        assertFailure(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE)
        assertTrue(responseBodyClosed)
    }

    @Test
    fun acceptsUpToThreeValidatedRedirects() {
        val intermediateUrls = (1..2).map { "$BASE_URL/redirect-$it?pblancId=$SOURCE_PROGRAM_ID" }
        val urls = listOf(SOURCE_URL) + intermediateUrls + "$BASE_URL$CURRENT_DETAIL_PATH"
        urls.zipWithNext().forEach { (from, to) ->
            server.expect(requestTo(from))
                .andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, to))
        }
        server.expect(requestTo(urls.last()))
            .andRespond(withSuccess(HTML, MediaType.TEXT_HTML))

        assertEquals(HTML, client.fetchHtml(SOURCE_URL, SOURCE_PROGRAM_ID))
    }

    @Test
    fun rejectsMoreThanThreeRedirectsWithoutRequestingTheFourthTarget() {
        val urls = listOf(SOURCE_URL) + (1..4).map { "$BASE_URL/redirect-$it?pblancId=$SOURCE_PROGRAM_ID" }
        urls.zipWithNext().forEach { (from, to) ->
            server.expect(requestTo(from))
                .andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, to))
        }

        assertFailure(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsRedirectCyclesBeforeRequestingAVisitedUrl() {
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, CURRENT_DETAIL_PATH))
        server.expect(requestTo("$BASE_URL$CURRENT_DETAIL_PATH"))
            .andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, SOURCE_URL))

        assertFailure(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsUnsafeOrMalformedUrlsBeforeMakingANetworkRequest() {
        val unsafeUrls = listOf(
            "http://www.bizinfo.go.kr$OFFICIAL_DETAIL_PATH?pblancId=PBLN_1",
            "https://example.com$OFFICIAL_DETAIL_PATH?pblancId=PBLN_1",
            "https://www.bizinfo.go.kr.example.com$OFFICIAL_DETAIL_PATH?pblancId=PBLN_1",
            "https://user@example.com@www.bizinfo.go.kr$OFFICIAL_DETAIL_PATH?pblancId=PBLN_1",
            "https://www.bizinfo.go.kr:444$OFFICIAL_DETAIL_PATH?pblancId=PBLN_1",
            "$OFFICIAL_DETAIL_PATH?pblancId=PBLN_1",
            "not a valid URI",
        )

        unsafeUrls.forEach { sourceUrl ->
            val exception = assertThrows(BizInfoSourceDocumentClientException::class.java) {
                client.fetchHtml(sourceUrl, SOURCE_PROGRAM_ID)
            }

            assertEquals(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE, exception.failure)
        }
    }

    @Test
    fun rejectsNonHtmlAndEmptyResponses() {
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withSuccess("{\"detail\":\"not html\"}", MediaType.APPLICATION_JSON))
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withSuccess("", MediaType.TEXT_HTML))

        assertFailure(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE)
        assertFailure(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsHtmlThatExceedsTheSafeByteLimit() {
        val oversizedHtml = "<html><body>${"a".repeat(500_001)}</body></html>"
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withSuccess(oversizedHtml, MediaType.TEXT_HTML))

        assertFailure(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun mapsHttpTransportAndTimeoutFailuresToStableClientFailures() {
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withStatus(HttpStatus.BAD_GATEWAY))
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withException(ConnectException("connection refused")))
        server.expect(requestTo(SOURCE_URL))
            .andRespond(withException(SocketTimeoutException("read timeout")))

        assertFailure(BizInfoSourceDocumentClientException.Failure.UPSTREAM_ERROR)
        assertFailure(BizInfoSourceDocumentClientException.Failure.UNAVAILABLE)
        assertFailure(BizInfoSourceDocumentClientException.Failure.TIMEOUT)
    }

    @Test
    fun rejectsUrlsThatDoNotIdentifyExactlyTheRequestedPublication() {
        val invalidUrls = listOf(
            "$BASE_URL$OFFICIAL_DETAIL_PATH?pblancId=PBLN_OTHER",
            "$BASE_URL$OFFICIAL_DETAIL_PATH?id=$SOURCE_PROGRAM_ID",
            "$BASE_URL$OFFICIAL_DETAIL_PATH?pblancId=$SOURCE_PROGRAM_ID&pblancId=$SOURCE_PROGRAM_ID",
        )

        invalidUrls.forEach { sourceUrl ->
            val exception = assertThrows(BizInfoSourceDocumentClientException::class.java) {
                client.fetchHtml(sourceUrl, SOURCE_PROGRAM_ID)
            }
            assertEquals(BizInfoSourceDocumentClientException.Failure.INVALID_RESPONSE, exception.failure)
        }
    }

    private fun assertFailure(expected: BizInfoSourceDocumentClientException.Failure) {
        val exception = assertThrows(BizInfoSourceDocumentClientException::class.java) {
            client.fetchHtml(SOURCE_URL, SOURCE_PROGRAM_ID)
        }

        assertEquals(expected, exception.failure)
    }

    private companion object {
        const val BASE_URL = "https://www.bizinfo.go.kr"
        const val OFFICIAL_DETAIL_PATH = "/web/lay1/bbs/S1T122C128/AS/74/view.do"
        const val SOURCE_PROGRAM_ID = "PBLN_1"
        const val SOURCE_URL = "$BASE_URL$OFFICIAL_DETAIL_PATH?pblancId=$SOURCE_PROGRAM_ID"
        const val CURRENT_DETAIL_PATH = "/sii/siia/selectSIIA200Detail.do?pblancId=$SOURCE_PROGRAM_ID"
        const val HTML = "<html><body><main>기업마당 공고 원문</main></body></html>"
    }
}
