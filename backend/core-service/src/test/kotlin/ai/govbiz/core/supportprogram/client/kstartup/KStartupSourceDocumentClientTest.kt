package ai.govbiz.core.supportprogram.client.kstartup

import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupSourceDocumentClientException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
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
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withException
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class KStartupSourceDocumentClientTest {

    private lateinit var server: MockRestServiceServer
    private lateinit var client: KStartupSourceDocumentClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder()
        server = MockRestServiceServer.bindTo(builder).build()
        client = KStartupSourceDocumentClient(builder.build())
    }

    @AfterEach
    fun verifiesEveryExpectedRequest() {
        server.verify()
    }

    @Test
    fun fetchesHtmlOnlyFromTheOfficialDetailUrl() {
        server.expect(requestTo(ONGOING_URL))
            .andExpect(method(HttpMethod.GET))
            .andExpect(header(HttpHeaders.ACCEPT, MediaType.TEXT_HTML_VALUE))
            .andRespond(withSuccess(DETAIL_HTML, MediaType(MediaType.TEXT_HTML, StandardCharsets.UTF_8)))

        assertEquals(DETAIL_HTML, client.fetchHtml(ONGOING_URL, ID))
    }

    @Test
    fun followsTheClosedProgramStatusPageHandoffExactlyOnce() {
        server.expect(requestTo(ONGOING_URL))
            .andRespond(withSuccess(handoff("/web/contents/bizpbanc-deadline.do?schM=view&amp;pbancSn=$ID"), MediaType.TEXT_HTML))
        server.expect(requestTo(DEADLINE_URL))
            .andExpect(header(HttpHeaders.ACCEPT, MediaType.TEXT_HTML_VALUE))
            .andRespond(withSuccess(DETAIL_HTML, MediaType.TEXT_HTML))

        assertEquals(DETAIL_HTML, client.fetchHtml(ONGOING_URL, ID))
    }

    @Test
    fun rejectsStatusPageLoopsWithoutRequestingMoreThanTheDeadlinePage() {
        server.expect(requestTo(ONGOING_URL))
            .andRespond(withSuccess(handoff("/web/contents/bizpbanc-deadline.do?schM=view&pbancSn=$ID"), MediaType.TEXT_HTML))
        server.expect(requestTo(DEADLINE_URL))
            .andRespond(withSuccess(handoff("/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=$ID"), MediaType.TEXT_HTML))
        server.expect(requestTo(DEADLINE_URL))
            .andRespond(withSuccess(handoff("/web/contents/bizpbanc-deadline.do?schM=view&pbancSn=$ID"), MediaType.TEXT_HTML))

        assertFailure(KStartupSourceDocumentClientException.Failure.INVALID_RESPONSE)
        assertFailure(KStartupSourceDocumentClientException.Failure.INVALID_RESPONSE, DEADLINE_URL)
    }

    @Test
    fun rejectsHandoffsToOtherHostsProgramsOrPagesBeforeRequestingThem() {
        val unsafeTargets = listOf(
            "https://attacker.test/web/contents/bizpbanc-deadline.do?schM=view&pbancSn=$ID",
            "http://www.k-startup.go.kr/web/contents/bizpbanc-deadline.do?schM=view&pbancSn=$ID",
            "/web/contents/bizpbanc-deadline.do?schM=view&pbancSn=177423",
            "/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=$ID",
            "/web/contents/bizpbanc-list.do?schM=view&pbancSn=$ID",
            "not a valid URI",
        )
        unsafeTargets.forEach { target ->
            server.expect(requestTo(ONGOING_URL)).andRespond(withSuccess(handoff(target), MediaType.TEXT_HTML))
        }

        unsafeTargets.forEach { _ -> assertFailure(KStartupSourceDocumentClientException.Failure.INVALID_RESPONSE) }
    }

    @Test
    fun rejectsUnsafeOrMismatchedSourceUrlsBeforeMakingANetworkRequest() {
        listOf(
            "http://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=$ID",
            "https://attacker.test/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=$ID",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=177423",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view",
            "/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=$ID",
            "not a valid URI",
        ).forEach { sourceUrl ->
            assertFailure(KStartupSourceDocumentClientException.Failure.INVALID_RESPONSE, sourceUrl)
        }
    }

    @Test
    fun rejectsNonHtmlEmptyAndOversizedResponses() {
        server.expect(requestTo(ONGOING_URL))
            .andRespond(withSuccess("{\"detail\":\"not html\"}", MediaType.APPLICATION_JSON))
        server.expect(requestTo(ONGOING_URL))
            .andRespond(withSuccess("", MediaType.TEXT_HTML))
        server.expect(requestTo(ONGOING_URL))
            .andRespond(withSuccess("<html><body>${"a".repeat(1_000_001)}</body></html>", MediaType.TEXT_HTML))

        repeat(3) { assertFailure(KStartupSourceDocumentClientException.Failure.INVALID_RESPONSE) }
    }

    @Test
    fun classifiesMissingPagesServerErrorsTransportFailuresAndTimeouts() {
        server.expect(requestTo(ONGOING_URL)).andRespond(withStatus(HttpStatus.NOT_FOUND))
        server.expect(requestTo(ONGOING_URL)).andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE))
        server.expect(requestTo(ONGOING_URL))
            .andRespond(withStatus(HttpStatus.FOUND).header(HttpHeaders.LOCATION, DEADLINE_URL))
        server.expect(requestTo(ONGOING_URL)).andRespond(withException(ConnectException("connection refused")))
        server.expect(requestTo(ONGOING_URL)).andRespond(withException(SocketTimeoutException("read timeout")))

        assertFailure(KStartupSourceDocumentClientException.Failure.UPSTREAM_ERROR)
        assertFailure(KStartupSourceDocumentClientException.Failure.UPSTREAM_ERROR)
        // HTTP 리다이렉트는 따르지 않으므로 Location의 마감 페이지를 요청하지 않습니다.
        assertFailure(KStartupSourceDocumentClientException.Failure.UPSTREAM_ERROR)
        assertFailure(KStartupSourceDocumentClientException.Failure.UNAVAILABLE)
        assertFailure(KStartupSourceDocumentClientException.Failure.TIMEOUT)
    }

    private fun assertFailure(
        expected: KStartupSourceDocumentClientException.Failure,
        sourceUrl: String = ONGOING_URL,
    ) {
        val exception = assertThrows(KStartupSourceDocumentClientException::class.java) {
            client.fetchHtml(sourceUrl, ID)
        }
        assertEquals(expected, exception.failure)
    }

    private fun handoff(target: String) = "<script>\n  var fullUrl = '$target';\n  url = new URL(fullUrl);\n</script>"

    private companion object {
        const val ID = "178927"
        const val ONGOING_URL = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=$ID"
        const val DEADLINE_URL = "https://www.k-startup.go.kr/web/contents/bizpbanc-deadline.do?schM=view&pbancSn=$ID"
        const val DETAIL_HTML = "<div class=\"app_notice_details-wrap\"><div id=\"scrTitle\"><h3>K-Startup 공고</h3></div></div>"
    }
}
