package ai.govbiz.core.supportprogram.client.msit

import ai.govbiz.core.supportprogram.client.msit.config.MsitClientProperties
import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
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

class MsitClientTest {
    private lateinit var server: MockRestServiceServer
    private lateinit var client: MsitClient
    private lateinit var restClient: RestClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder().baseUrl(BASE_URL)
        server = MockRestServiceServer.bindTo(builder).build()
        restClient = builder.build()
        client = MsitClient(restClient, properties())
    }

    @AfterEach
    fun verifyRequests() { server.verify() }

    @Test
    fun readsEveryTenItemPageAndThePartialLastPageUsingStableAnnouncementIds() {
        expectPage(1, page((1..10).map { row(it.toString()) }, total = 12))
        expectPage(2, page((11..12).map { row(it.toString()) }, total = 12, number = 2))

        assertEquals((1..12).map { "사업 $it" }, client.fetchAll().map { it.title })
    }

    @Test
    fun decodesTheOfficialSplitEnvelopeAndStringPaginationWithoutFetchingAttachments() {
        expectPage(1, page(listOf("""{"item":{
            "subject":"첨단 산업 R&amp;D 공고", "deptName":"연구개발정책과", "pressDt":"2026-09-09",
            "viewUrl":"https://www.msit.go.kr/bbs/view.do?sCode=user&mId=311&mPid=121&bbsSeqNo=100&nttSeqNo=3186878",
            "managerName":"담당자", "managerTel":"00-000-0000",
            "files":[{"file":{"fileName":"공고문.hwp", "fileUrl":"https://attachments.example.test/file"}}]
        }}""")))

        val item = client.fetchAll().single()
        assertEquals("첨단 산업 R&amp;D 공고", item.title)
        assertEquals("연구개발정책과", item.organization)
        assertEquals("2026-09-09", item.publishedAt)
        assertEquals("https://www.msit.go.kr/bbs/view.do?sCode=user&mId=311&mPid=121&bbsSeqNo=100&nttSeqNo=3186878", item.sourceUrl)
    }

    @Test
    fun acceptsAnExplicitlyCompleteEmptySnapshot() {
        expectPage(1, page(emptyList()))
        assertEquals(emptyList<Any>(), client.fetchAll())
    }

    @Test
    fun blankKeyDoesNotCallTheNetwork() {
        client = MsitClient(restClient, properties("  "))
        assertFailure(MsitClientException.Failure.NOT_CONFIGURED)
    }

    @Test
    fun rejectsIncompletePagesAndUnsupportedPaginationBeforeReturningAnyData() {
        val bodies = listOf(
            page(listOf(row("1")), total = 2),
            page(listOf(row("1")), number = 2),
            page(emptyList(), perPage = 0), page(emptyList(), perPage = 11),
            page(emptyList(), total = 20_001), page(emptyList(), total = 2001, perPage = 1),
        )
        bodies.forEach { expectPage(1, it) }
        bodies.forEach { _ -> assertFailure(MsitClientException.Failure.INVALID_RESPONSE) }
    }

    @Test
    fun rejectsChangedTotalsSizesAndPageNumbersOnLaterPages() {
        val badSecondPages = listOf(
            page(listOf(row("2")), total = 3, number = 2, perPage = 1),
            page(listOf(row("2")), total = 2, number = 2, perPage = 2),
            page(listOf(row("2")), total = 2, number = 1, perPage = 1),
            page(emptyList(), total = 2, number = 2, perPage = 1),
        )
        badSecondPages.forEach {
            expectPage(1, page(listOf(row("1")), total = 2, perPage = 1))
            expectPage(2, it)
        }
        badSecondPages.forEach { _ -> assertFailure(MsitClientException.Failure.INVALID_RESPONSE) }
    }

    @Test
    fun rejectsDuplicateStableIdsEvenIfUnrelatedQueryParametersDiffer() {
        expectPage(1, page(listOf(row("1")), total = 2, perPage = 1))
        expectPage(2, page(listOf(row("1").replace("nttSeqNo=1", "nttSeqNo=1&mId=311")), total = 2, number = 2, perPage = 1))
        assertFailure(MsitClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun aLaterHttpFailureNeverReturnsAPartialSnapshot() {
        expectPage(1, page(listOf(row("1")), total = 2, perPage = 1))
        expectResponse(2, withStatus(HttpStatusCode.valueOf(503)))
        assertFailure(MsitClientException.Failure.UPSTREAM_ERROR)
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "null", "[]", "{", "{}", "{\"response\":[]}",
        "{\"response\":[{\"header\":{\"resultCode\":\"30\",\"resultMsg\":\"test+key/=\"}}]}",
        "{\"response\":[{\"header\":{\"resultCode\":\"00\"}},{\"body\":{\"items\":[]}}]}"])
    fun rejectsMalformedAndMissingEnvelopesWithoutLeakingResponseContent(body: String) {
        expectPage(1, body)
        val failure = assertFailure(MsitClientException.Failure.INVALID_RESPONSE)
        assertFalse(failure.stackTraceToString().contains(RAW_KEY))
        assertNull(failure.cause)
    }

    @Test
    fun rejectsUnsuccessfulResultCodesAndMalformedFields() {
        val bodies = listOf(
            page(emptyList()).replace("\"00\"", "\"99\""),
            page(emptyList()).replace("\"pageNo\":\"1\"", "\"pageNo\":1.5"),
            page(emptyList()).replace("\"totalCount\":0", "\"totalCount\":-1"),
            page(emptyList()).replace("\"numOfRows\":10", "\"numOfRows\":\"2147483648\""),
            page(listOf("null")), page(listOf("{}")),
            page(listOf(row("1").replace("\"subject\":\"사업 1\"", "\"subject\":[]"))),
            page(listOf(row("1").replace("www.msit.go.kr", "www.msit.go.kr.evil.test"))),
        )
        bodies.forEach { expectPage(1, it) }
        bodies.forEach { _ -> assertFailure(MsitClientException.Failure.INVALID_RESPONSE) }
    }

    @ParameterizedTest
    @ValueSource(ints = [206, 302, 400, 500])
    fun rejectsEveryNon200StatusWithoutExposingTheKey(status: Int) {
        expectResponse(1, withStatus(HttpStatusCode.valueOf(status)).body("serviceKey=$RAW_KEY"))
        val failure = assertFailure(MsitClientException.Failure.UPSTREAM_ERROR)
        assertFalse(failure.stackTraceToString().contains(RAW_KEY))
        assertNull(failure.cause)
    }

    @Test
    fun sanitizesConnectionAndTimeoutExceptions() {
        expectResponse(1, withException(ConnectException("$BASE_URL?serviceKey=$RAW_KEY")))
        expectResponse(1, withException(SocketTimeoutException("$BASE_URL?serviceKey=$RAW_KEY")))
        val connection = assertFailure(MsitClientException.Failure.UNAVAILABLE)
        val timeout = assertFailure(MsitClientException.Failure.TIMEOUT)
        for (failure in listOf(connection, timeout)) {
            assertFalse(failure.stackTraceToString().contains(RAW_KEY))
            assertNull(failure.cause)
        }
    }

    private fun expectPage(number: Int, body: String) = expectResponse(number, withSuccess(body, MediaType.APPLICATION_JSON))

    private fun expectResponse(number: Int, response: ResponseCreator) {
        server.expect { request ->
            assertEquals(HttpMethod.GET, request.method)
            assertEquals(MsitClient.PROGRAMS_PATH, request.uri.path)
            val query = request.uri.rawQuery.split('&').associate { parameter ->
                URLDecoder.decode(parameter.substringBefore('='), StandardCharsets.UTF_8) to
                    URLDecoder.decode(parameter.substringAfter('='), StandardCharsets.UTF_8)
            }
            assertEquals(mapOf("serviceKey" to RAW_KEY, "pageNo" to number.toString(), "numOfRows" to "10", "returnType" to "json"), query)
        }.andRespond(response)
    }

    private fun assertFailure(expected: MsitClientException.Failure): MsitClientException {
        val failure = assertThrows(MsitClientException::class.java) { client.fetchAll() }
        assertEquals(expected, failure.failure)
        return failure
    }

    private fun properties(key: String = "test%2Bkey%2F%3D") = MsitClientProperties(URI(BASE_URL), key, null, null)
    private fun row(id: String) = """{"item":{"subject":"사업 $id","viewUrl":"https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=$id"}}"""
    private fun page(items: List<String>, total: Int = items.size, number: Int = 1, perPage: Int = 10) =
        """{"response":[{"header":{"resultCode":"00","resultMsg":"NORMAL_CODE"}},{"body":{"pageNo":"$number","totalCount":$total,"numOfRows":$perPage,"items":[${items.joinToString(",")}]}}]}"""

    private companion object {
        const val BASE_URL = "https://msit-api.test"
        const val RAW_KEY = "test+key/="
    }
}
