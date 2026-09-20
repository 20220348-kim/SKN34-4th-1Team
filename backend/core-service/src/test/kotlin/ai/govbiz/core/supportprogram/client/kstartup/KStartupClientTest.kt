package ai.govbiz.core.supportprogram.client.kstartup

import ai.govbiz.core.supportprogram.client.kstartup.config.KStartupClientProperties
import ai.govbiz.core.supportprogram.client.kstartup.config.KStartupCollectionScope
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupClientException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
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

class KStartupClientTest {
    private lateinit var server: MockRestServiceServer
    private lateinit var client: KStartupClient
    private lateinit var restClient: RestClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder().baseUrl(BASE_URL)
        server = MockRestServiceServer.bindTo(builder).build()
        restClient = builder.build()
        client = KStartupClient(restClient, properties(), CLOCK)
    }

    @AfterEach
    fun verifyRequests() { server.verify() }

    @Test
    fun paginatesByMatchCountNotGlobalTotalAndDecodesTheKeyOnce() {
        expectPage(1, page(listOf(row("179197")), matchCount = 2, perPage = 1))
        expectPage(2, page(listOf(row("179198")), matchCount = 2, perPage = 1, page = 2))

        assertEquals(listOf("179197", "179198"), client.fetchAll().map { it.id })
    }

    @Test
    fun usesSeoulDateForTheRecentYearScopeAndStablePbancSnInsteadOfRowId() {
        expectPage(1, page(listOf("""{"id":1,"pbanc_sn":179197,"biz_pbanc_nm":"법률지원"}""")))

        val item = client.fetchAll().single()
        assertEquals("179197", item.id)
        assertEquals("법률지원", item.title)
    }

    @ParameterizedTest
    @CsvSource(
        "2026-09-08T15:30:00Z, 20260609",
        "2026-05-30T15:30:00Z, 20260228",
        "2024-05-30T15:30:00Z, 20240229",
    )
    fun recentThreeMonthsUsesSeoulCalendarMonthsIncludingMonthEnds(instant: String, startDate: String) {
        client = KStartupClient(restClient, properties(scope = KStartupCollectionScope.RECENT_THREE_MONTHS),
            Clock.fixed(Instant.parse(instant), CLOCK.zone))
        expectPage(1, page(listOf(row("179197"))), scope = KStartupCollectionScope.RECENT_THREE_MONTHS,
            startDate = startDate)

        assertEquals(1, client.fetchAll().size)
    }

    @Test
    fun recentThreeMonthsKeepsTheSameDateBoundaryWhenSeoulMidnightPassesBetweenPages() {
        var currentInstant = Instant.parse("2026-09-09T14:59:59Z")
        val clock = object : Clock() {
            override fun getZone(): ZoneId = CLOCK.zone
            override fun withZone(zone: ZoneId): Clock = Clock.fixed(currentInstant, zone)
            override fun instant(): Instant = currentInstant
        }
        client = KStartupClient(restClient, properties(scope = KStartupCollectionScope.RECENT_THREE_MONTHS), clock)
        val firstResponse = withSuccess(page(listOf(row("179197")), matchCount = 2, perPage = 1),
            MediaType.APPLICATION_JSON)
        expectResponse(1, { request ->
            currentInstant = Instant.parse("2026-09-09T15:00:00Z")
            firstResponse.createResponse(request)
        }, scope = KStartupCollectionScope.RECENT_THREE_MONTHS, startDate = "20260609")
        expectPage(2, page(listOf(row("179198")), matchCount = 2, perPage = 1, page = 2),
            scope = KStartupCollectionScope.RECENT_THREE_MONTHS, startDate = "20260609")

        assertEquals(listOf("179197", "179198"), client.fetchAll().map { it.id })
    }

    @Test
    fun decodesOfficialFieldNamesIncludingOriginalAndExcludedTargets() {
        expectPage(1, page(listOf("""{
            "id":1,"pbanc_sn":179197,"biz_pbanc_nm":"법률지원","pbanc_ntrp_nm":"창업진흥원",
            "pbanc_ctnt":"사업 설명","aply_trgt_ctnt":"예비창업자 및 창업기업","aply_excl_trgt_ctnt":"제외 업종",
            "aply_trgt":"일반인,일반기업","biz_enyy":"예비창업자,1년미만","biz_trgt_age":"만 40세 이상",
            "supt_biz_clsfc":"멘토링ㆍ컨설팅ㆍ교육","supt_regin":"전국",
            "pbanc_rcpt_bgng_dt":"20260908","pbanc_rcpt_end_dt":"20260911",
            "detl_pg_url":"https://www.k-startup.go.kr/detail?pbancSn=179197",
            "ignored_future_field":{"extra":true}
        }""")))

        val item = client.fetchAll().single()
        assertEquals("창업진흥원", item.organization)
        assertEquals("사업 설명", item.summaryHtml)
        assertEquals("예비창업자 및 창업기업", item.target)
        assertEquals("제외 업종", item.excludedTarget)
        assertEquals("일반인,일반기업", item.applicantTypes)
        assertEquals("예비창업자,1년미만", item.startupStages)
        assertEquals("만 40세 이상", item.founderAges)
        assertEquals("멘토링ㆍ컨설팅ㆍ교육", item.category)
        assertEquals("전국", item.region)
        assertEquals("20260908", item.applicationStartDate)
        assertEquals("20260911", item.applicationEndDate)
        assertEquals("https://www.k-startup.go.kr/detail?pbancSn=179197", item.sourceUrl)
    }

    @Test
    fun openScopeSendsOnlyTheRecruitmentCondition() {
        client = KStartupClient(restClient, properties(scope = KStartupCollectionScope.OPEN), CLOCK)
        expectPage(1, page(listOf(row("179197"))), scope = KStartupCollectionScope.OPEN)
        assertEquals(1, client.fetchAll().size)
    }

    @Test
    fun permitsACompleteEmptyScopedResultEvenWhenGlobalCatalogIsNonempty() {
        expectPage(1, page(emptyList()))
        assertEquals(emptyList<Any>(), client.fetchAll())
    }

    @Test
    fun blankKeyDoesNotCallTheNetwork() {
        client = KStartupClient(restClient, properties("  "), CLOCK)
        assertFailure(KStartupClientException.Failure.NOT_CONFIGURED)
    }

    @Test
    fun rejectsIncompleteOrInconsistentPagination() {
        val bodies = listOf(
            page(listOf(row("1")), matchCount = 2),
            page(listOf(row("1")), currentCount = 0),
            page(listOf(row("1")), page = 2),
            page(emptyList(), perPage = 0),
            page(emptyList(), perPage = 1001),
            page(emptyList(), matchCount = 20_001),
            page(emptyList(), matchCount = 2, totalCount = 1),
            page(emptyList(), matchCount = 201, perPage = 1),
        )
        bodies.forEach { expectPage(1, it) }
        bodies.forEach { _ ->
            assertFailure(KStartupClientException.Failure.INVALID_RESPONSE)
        }
    }

    @Test
    fun rejectsPaginationChangesOnLaterPages() {
        expectPage(1, page(listOf(row("1")), matchCount = 2, perPage = 1))
        expectPage(2, page(listOf(row("2")), matchCount = 3, perPage = 1, page = 2))
        assertFailure(KStartupClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsDuplicateStableIdsAcrossPages() {
        expectPage(1, page(listOf(row("1")), matchCount = 2, perPage = 1))
        expectPage(2, page(listOf(row("1")), matchCount = 2, perPage = 1, page = 2))
        assertFailure(KStartupClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun neverReturnsAPartialSnapshotWhenTheNextPageFails() {
        expectPage(1, page(listOf(row("1")), matchCount = 2, perPage = 1))
        expectResponse(2, withStatus(HttpStatusCode.valueOf(503)))
        assertFailure(KStartupClientException.Failure.UPSTREAM_ERROR)
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "null", "[]", "{", "{\"code\":30,\"msg\":\"secret-error\"}",
        "{\"data\":[],\"currentCount\":0,\"matchCount\":0,\"page\":1,\"perPage\":1000}"])
    fun rejectsEmptyMalformedAndIncompleteEnvelopes(body: String) {
        expectPage(1, body)
        assertFailure(KStartupClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsNullProgramsMissingIdsAndWrongFieldTypes() {
        val items = listOf("null", "{}", "{\"pbanc_sn\":1.5}", "{\"pbanc_sn\":-1}",
            "{\"pbanc_sn\":1,\"supt_regin\":[]}")
        items.forEach { expectPage(1, page(listOf(it))) }
        items.forEach { _ ->
            assertFailure(KStartupClientException.Failure.INVALID_RESPONSE)
        }
    }

    @ParameterizedTest
    @ValueSource(ints = [206, 302, 400, 500])
    fun rejectsEveryNon200StatusWithoutExposingTheKey(status: Int) {
        expectResponse(1, withStatus(HttpStatusCode.valueOf(status)).body("secret=$RAW_KEY"))
        val failure = assertFailure(KStartupClientException.Failure.UPSTREAM_ERROR)
        assertFalse(failure.stackTraceToString().contains(RAW_KEY))
        assertNull(failure.cause)
    }

    @Test
    fun sanitizesConnectionAndTimeoutExceptions() {
        expectResponse(1, withException(ConnectException("$BASE_URL?serviceKey=$RAW_KEY")))
        expectResponse(1, withException(SocketTimeoutException("$BASE_URL?serviceKey=$RAW_KEY")))
        val connection = assertFailure(KStartupClientException.Failure.UNAVAILABLE)
        assertFalse(connection.stackTraceToString().contains(RAW_KEY))
        assertNull(connection.cause)
        val timeout = assertFailure(KStartupClientException.Failure.TIMEOUT)
        assertFalse(timeout.stackTraceToString().contains(RAW_KEY))
        assertNull(timeout.cause)
    }

    private fun expectPage(number: Int, body: String, scope: KStartupCollectionScope = KStartupCollectionScope.RECENT_YEAR,
        startDate: String = "20250909") =
        expectResponse(number, withSuccess(body, MediaType.APPLICATION_JSON), scope, startDate)

    private fun expectResponse(number: Int, response: ResponseCreator, scope: KStartupCollectionScope = KStartupCollectionScope.RECENT_YEAR,
        startDate: String = "20250909") {
        server.expect { request ->
            assertEquals(HttpMethod.GET, request.method)
            assertEquals(KStartupClient.PROGRAMS_PATH, request.uri.path)
            val query = request.uri.rawQuery.split('&').associate { parameter ->
                URLDecoder.decode(parameter.substringBefore('='), StandardCharsets.UTF_8) to
                    URLDecoder.decode(parameter.substringAfter('='), StandardCharsets.UTF_8)
            }
            val condition = if (scope == KStartupCollectionScope.OPEN) "cond[rcrt_prgs_yn::EQ]" to "Y"
                else "cond[pbanc_rcpt_bgng_dt::GTE]" to startDate
            assertEquals(mapOf("serviceKey" to RAW_KEY, "page" to number.toString(), "perPage" to "1000", "returnType" to "JSON", condition), query)
        }.andRespond(response)
    }

    private fun assertFailure(expected: KStartupClientException.Failure): KStartupClientException {
        val failure = assertThrows(KStartupClientException::class.java) { client.fetchAll() }
        assertEquals(expected, failure.failure)
        return failure
    }

    private fun properties(key: String = "test%2Bkey%2F%3D", scope: KStartupCollectionScope = KStartupCollectionScope.RECENT_YEAR) =
        KStartupClientProperties(URI(BASE_URL), key, Duration.ofSeconds(1), Duration.ofSeconds(2), scope)

    private fun row(id: String) = """{"id":999,"pbanc_sn":"$id"}"""
    private fun page(items: List<String>, matchCount: Int = items.size, currentCount: Int = items.size,
        page: Int = 1, perPage: Int = 1000, totalCount: Int = 30047) =
        """{"currentCount":$currentCount,"matchCount":$matchCount,"totalCount":$totalCount,"page":$page,"perPage":$perPage,"data":[${items.joinToString(",")}]}"""

    private companion object {
        const val BASE_URL = "https://kstartup-api.test"
        const val RAW_KEY = "test+key/="
        val CLOCK: Clock = Clock.fixed(Instant.parse("2026-09-08T15:30:00Z"), ZoneId.of("Asia/Seoul"))
    }
}
