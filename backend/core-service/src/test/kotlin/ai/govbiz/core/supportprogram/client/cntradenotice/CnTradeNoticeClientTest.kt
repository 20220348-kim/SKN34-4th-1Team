package ai.govbiz.core.supportprogram.client.cntradenotice

import ai.govbiz.core.supportprogram.client.cntradenotice.config.CnTradeNoticeClientProperties
import ai.govbiz.core.supportprogram.client.cntradenotice.exception.CnTradeNoticeClientException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatusCode
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.ResponseCreator
import org.springframework.test.web.client.response.MockRestResponseCreators.withException
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class CnTradeNoticeClientTest {
    private lateinit var server: MockRestServiceServer
    private lateinit var client: CnTradeNoticeClient
    private lateinit var restClient: RestClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder().baseUrl(BASE_URL)
        server = MockRestServiceServer.bindTo(builder).build()
        restClient = builder.build()
        client = CnTradeNoticeClient(restClient, properties())
    }

    @AfterEach
    fun verifyRequests() { server.verify() }

    @Test
    fun decodesTheDocumentedTopLevelSuccessEnvelopeAndOfficialFieldNames() {
        // 공식 포털 15097093 첨부 DOCX의 응답 예시를 기준으로 축약한 fixture입니다.
        // 실제 인증 호출은 HTTP 200/04 HTTP_ERROR였으므로 live 연동 성공을 의미하지 않습니다.
        expectPage(1, page(listOf("""{
            "lbbNo":3862,"orgNm":"국제통상과","smodifyDtm":"2021-10-22","sregDtm":"2021-10-22",
            "title":"(경기평택항만공사) 2021 글로벌 점프업 지원사업 2차 모집 안내",
            "cont":"<p>경기평택항만공사에서 추진하는 지원사업</p>","vwCnt":8,"futureField":{}
        }""")))

        val item = client.fetchAll().single()
        assertEquals("3862", item.id)
        assertEquals("국제통상과", item.organization)
        assertEquals("2021-10-22", item.registeredDate)
        assertEquals("2021-10-22", item.modifiedDate)
        assertEquals("<p>경기평택항만공사에서 추진하는 지원사업</p>", item.contentHtml)
    }

    @Test
    fun collectsEveryPageAndSendsLowercaseServiceKeyExactlyOnceEncoded() {
        expectPage(1, page(listOf(row("3862")), totalCount = 2, numOfRows = 1))
        expectPage(2, page(listOf(row("3781")), totalCount = 2, numOfRows = 1, pageNo = 2))
        assertEquals(listOf("3862", "3781"), client.fetchAll().map { it.id })
    }

    @Test
    fun acceptsOnlyAnExplicitCompleteSuccessfulEmptySnapshot() {
        expectPage(1, page(emptyList()))
        assertEquals(emptyList<Any>(), client.fetchAll())
    }

    @Test
    fun blankKeyDoesNotCallTheNetwork() {
        client = CnTradeNoticeClient(restClient, properties("  "))
        assertFailure(CnTradeNoticeClientException.Failure.NOT_CONFIGURED)
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "null", "[]", "{", "{}",
        "{\"resultCode\":\"03\",\"resultMsg\":\"NO_DATA_ERROR\"}",
        "{\"resultCode\":\"09\",\"resultMsg\":\"RETURN_SUCCESS\"}",
        "{\"OpenAPI_ServiceResponse\":{\"cmmMsgHeader\":{\"errMsg\":\"HTTP_ERROR\",\"returnAuthMsg\":\"HTTP 에러\",\"returnReasonCode\":\"04\"}}}"])
    fun doesNotTreatGatewayOrProviderErrorsAsAnEmptySuccessfulSnapshot(body: String) {
        expectPage(1, body)
        assertFailure(CnTradeNoticeClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsTheDocumentedXmlGatewayErrorWithoutLeakingItsBody() {
        expectResponse(1, withSuccess(
            "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>$RAW_KEY</errMsg>" +
                "<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>" +
                "<returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>",
            MediaType.APPLICATION_XML,
        ))
        val failure = assertFailure(CnTradeNoticeClientException.Failure.INVALID_RESPONSE)
        assertFalse(failure.stackTraceToString().contains(RAW_KEY))
        assertNull(failure.cause)
    }

    @Test
    fun rejectsMissingWrongTypeOverflowAndUnsuccessfulMetadata() {
        val valid = page(emptyList())
        val bodies = listOf(
            valid.replace("\"09\"", "9"), valid.replace("RETURN_SUCCESS", "HTTP_ERROR"),
            valid.replace("\"totalCount\":0", "\"totalCount\":2147483648"),
            valid.replace("\"totalCount\":0", "\"totalCount\":-1"),
            valid.replace("\"totalCount\":0", "\"totalCount\":\"0\""),
            valid.replace("\"items\":[]", "\"items\":null"),
        )
        bodies.forEach { expectPage(1, it) }
        bodies.forEach { _ -> assertFailure(CnTradeNoticeClientException.Failure.INVALID_RESPONSE) }
    }

    @Test
    fun rejectsIncompleteOrOversizedPaginationBeforePublishingAnything() {
        val bodies = listOf(
            page(listOf(row("1")), totalCount = 2), page(listOf(row("1")), pageNo = 2),
            page(emptyList(), numOfRows = 0), page(emptyList(), numOfRows = 1001),
            page(emptyList(), totalCount = 20_001), page(emptyList(), totalCount = 201, numOfRows = 1),
        )
        bodies.forEach { expectPage(1, it) }
        bodies.forEach { _ -> assertFailure(CnTradeNoticeClientException.Failure.INVALID_RESPONSE) }
    }

    @Test
    fun rejectsCountsThatChangeOnLaterPages() {
        expectPage(1, page(listOf(row("1")), totalCount = 2, numOfRows = 1))
        expectPage(2, page(listOf(row("2")), totalCount = 3, numOfRows = 1, pageNo = 2))
        assertFailure(CnTradeNoticeClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsDuplicateStableIdsAcrossPages() {
        expectPage(1, page(listOf(row("1")), totalCount = 2, numOfRows = 1))
        expectPage(2, page(listOf(row("1")), totalCount = 2, numOfRows = 1, pageNo = 2))
        assertFailure(CnTradeNoticeClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun neverReturnsTheFirstPageWhenALaterPageFails() {
        expectPage(1, page(listOf(row("1")), totalCount = 2, numOfRows = 1))
        expectResponse(2, withStatus(HttpStatusCode.valueOf(503)))
        assertFailure(CnTradeNoticeClientException.Failure.UPSTREAM_ERROR)
    }

    @Test
    fun rejectsNonObjectNoticesUnsafeIdsAndUnexpectedFieldTypes() {
        val rows = listOf("null", "{}", "{\"lbbNo\":1.5}", "{\"lbbNo\":-1}",
            "{\"lbbNo\":\"01\"}", "{\"lbbNo\":\"<script>\"}", "{\"lbbNo\":1,\"cont\":[]}")
        rows.forEach { expectPage(1, page(listOf(it))) }
        rows.forEach { _ -> assertFailure(CnTradeNoticeClientException.Failure.INVALID_RESPONSE) }
    }

    @ParameterizedTest
    @ValueSource(ints = [206, 302, 400, 500])
    fun rejectsNon200HttpResponsesWithoutLeakingTheApiKey(status: Int) {
        expectResponse(1, withStatus(HttpStatusCode.valueOf(status)).body("secret=$RAW_KEY"))
        val failure = assertFailure(CnTradeNoticeClientException.Failure.UPSTREAM_ERROR)
        assertFalse(failure.stackTraceToString().contains(RAW_KEY))
        assertNull(failure.cause)
    }

    @Test
    fun sanitizesConnectionAndTimeoutFailures() {
        expectResponse(1, withException(ConnectException("$BASE_URL?serviceKey=$RAW_KEY")))
        expectResponse(1, withException(SocketTimeoutException("$BASE_URL?serviceKey=$RAW_KEY")))
        val connection = assertFailure(CnTradeNoticeClientException.Failure.UNAVAILABLE)
        val timeout = assertFailure(CnTradeNoticeClientException.Failure.TIMEOUT)
        for (error in listOf(connection, timeout)) {
            assertFalse(error.stackTraceToString().contains(RAW_KEY))
            assertNull(error.cause)
        }
    }

    private fun expectPage(number: Int, body: String) = expectResponse(number, withSuccess(body, MediaType.APPLICATION_JSON))

    private fun expectResponse(number: Int, response: ResponseCreator) {
        server.expect { request ->
            assertEquals(HttpMethod.GET, request.method)
            assertEquals(CnTradeNoticeClient.NOTICES_PATH, request.uri.path)
            val query = request.uri.rawQuery.split('&').associate { parameter ->
                URLDecoder.decode(parameter.substringBefore('='), StandardCharsets.UTF_8) to
                    URLDecoder.decode(parameter.substringAfter('='), StandardCharsets.UTF_8)
            }
            assertEquals(mapOf("serviceKey" to RAW_KEY, "pageNo" to number.toString(), "numOfRows" to "1000"), query)
        }.andRespond(response)
    }

    private fun assertFailure(expected: CnTradeNoticeClientException.Failure): CnTradeNoticeClientException {
        val failure = assertThrows(CnTradeNoticeClientException::class.java) { client.fetchAll() }
        assertEquals(expected, failure.failure)
        return failure
    }

    private fun properties(key: String = "test%2Bkey%2F%3D") = CnTradeNoticeClientProperties(URI(BASE_URL), key, null, null)
    private fun row(id: String) = """{"lbbNo":"$id","title":"수출 공지"}"""
    private fun page(items: List<String>, pageNo: Int = 1, numOfRows: Int = 1000, totalCount: Int = items.size) =
        """{"resultCode":"09","resultMsg":"RETURN_SUCCESS","pageNo":$pageNo,"numOfRows":$numOfRows,"totalCount":$totalCount,"items":[${items.joinToString(",")}]}"""

    private companion object {
        const val BASE_URL = "https://cntrade-api.test"
        const val RAW_KEY = "test+key/="
    }
}
