package ai.govbiz.core.supportprogram.client.bizinfo

import ai.govbiz.core.supportprogram.client.bizinfo.config.BizInfoClientProperties
import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoClientException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URI
import java.time.Duration
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withException
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class BizInfoClientTest {

    private lateinit var server: MockRestServiceServer
    private lateinit var client: BizInfoClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder().baseUrl(BASE_URL)
        server = MockRestServiceServer.bindTo(builder).build()
        client = BizInfoClient(
            builder.build(),
            properties(ENCODED_KEY),
        )
    }

    @AfterEach
    fun verifiesEveryExpectedRequest() {
        server.verify()
    }

    @Test
    fun encodesAnAlreadyEncodedKeyExactlyOnceAndPaginatesFromTotalCount() {
        server.expect(requestTo(expectedUrl(1)))
            .andExpect(method(HttpMethod.GET))
            .andRespond(
                withSuccess(
                    wrappedPage(2, "PBLN_1", pageSize = 1),
                    MediaType.APPLICATION_JSON,
                ),
            )
        server.expect(requestTo(expectedUrl(2)))
            .andExpect(method(HttpMethod.GET))
            .andRespond(
                withSuccess(
                    directItemsPage(2, "PBLN_2", pageSize = 1),
                    MediaType.APPLICATION_JSON,
                ),
            )

        val programs = client.fetchAll()

        assertEquals(listOf("PBLN_1", "PBLN_2"), programs.map { it.id })
    }

    @Test
    fun decodesAWrapperContainingOneItemObject() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    wrappedSingleItemPage(1, "PBLN_1"),
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertEquals(listOf("PBLN_1"), client.fetchAll().map { it.id })
    }

    @Test
    fun rejectsAProtocolLevelFailureWithoutExposingItsMessage() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    """
                    {"response":{"header":{"resultCode":"30","resultMsg":"SECRET KEY ERROR"}}}
                    """.trimIndent(),
                    MediaType.APPLICATION_JSON,
                ),
            )

        val exception = assertThrows(BizInfoClientException::class.java) {
            client.fetchAll()
        }

        assertEquals(BizInfoClientException.Failure.UPSTREAM_ERROR, exception.failure)
    }

    @Test
    fun blankKeyFailsBeforeMakingANetworkRequest() {
        client = BizInfoClient(RestClient.create(BASE_URL), properties("   "))

        val exception = assertThrows(BizInfoClientException::class.java) {
            client.fetchAll()
        }

        assertEquals(BizInfoClientException.Failure.NOT_CONFIGURED, exception.failure)
    }

    @Test
    fun allowsMissingItemsOnlyForAnEmptyResult() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(withSuccess(pageWithoutItems(0), MediaType.APPLICATION_JSON))

        assertEquals(0, client.fetchAll().size)
    }

    @Test
    fun rejectsItemsWhenTotalCountIsZero() {
        val items = "[${item("PBLN_1")}]"
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    pageWithItems(0, items),
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsMissingItemsForANonEmptyResult() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(withSuccess(pageWithoutItems(1), MediaType.APPLICATION_JSON))

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsUnexpectedItemsShapeInsteadOfReturningAnEmptyCatalog() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    pageWithItems(1, "\"broken\""),
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsAMissingResultCodeAsAnInvalidResponse() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    """{"response":{"header":{},"body":{}}}""",
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsStructuredTextFieldsAsAnInvalidResponse() {
        val structuredTitle = item("PBLN_1").replace(
            "\"pblancNm\": \"서울 AI 사업\"",
            "\"pblancNm\": {}",
        )
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    pageWithItems(1, "[$structuredTitle]"),
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun ignoresUnusedSourceFieldsWithoutRejectingAnOtherwiseValidCatalog() {
        val sourceItem = item("PBLN_1").trim().dropLast(1) +
            """, "reqstMthPapersCn": {"unexpected": "unused source data"}}"""
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    pageWithItems(1, "[$sourceItem]"),
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertEquals(listOf("PBLN_1"), client.fetchAll().map { it.id })
    }

    @Test
    fun rejectsNegativeTotalCount() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(withSuccess(pageWithoutItems(-1), MediaType.APPLICATION_JSON))

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsResultsBeyondTheSafePaginationLimit() {
        val oversizedPage = pageWithItems(20_001, "[${item("PBLN_1")}]")
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    oversizedPage,
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsAPageContainingMoreItemsThanRequested() {
        val items = (1..1_001)
            .joinToString(prefix = "[", postfix = "]") { index -> item("PBLN_$index") }
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    pageWithItems(1_001, items),
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsInconsistentPaginationMetadata() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    wrappedPage(2, "PBLN_1", pageSize = 1),
                    MediaType.APPLICATION_JSON,
                ),
            )
        server.expect(requestTo(expectedUrl(2)))
            .andRespond(
                withSuccess(
                    directItemsPage(3, "PBLN_2", pageSize = 1),
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun rejectsAnIncompletePage() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(
                withSuccess(
                    pageWithItems(2, "[${item("PBLN_1")}]", pageSize = 2),
                    MediaType.APPLICATION_JSON,
                ),
            )

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun mapsUnexpectedHttpStatusToUpstreamError() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR))

        assertFailure(BizInfoClientException.Failure.UPSTREAM_ERROR)
    }

    @Test
    fun mapsConnectionFailureToUnavailable() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(withException(ConnectException("connection refused")))

        assertFailure(BizInfoClientException.Failure.UNAVAILABLE)
    }

    @Test
    fun mapsTimeoutToTimeout() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(withException(SocketTimeoutException("read timeout")))

        assertFailure(BizInfoClientException.Failure.TIMEOUT)
    }

    @Test
    fun mapsMalformedJsonToInvalidResponse() {
        server.expect(requestTo(expectedUrl(1)))
            .andRespond(withSuccess("{\"response\":", MediaType.APPLICATION_JSON))

        assertFailure(BizInfoClientException.Failure.INVALID_RESPONSE)
    }

    private fun assertFailure(expected: BizInfoClientException.Failure) {
        val exception = assertThrows(BizInfoClientException::class.java) {
            client.fetchAll()
        }
        assertEquals(expected, exception.failure)
    }

    private fun properties(serviceKey: String) =
        BizInfoClientProperties(
            URI.create(BASE_URL),
            serviceKey,
            Duration.ofSeconds(1),
            Duration.ofSeconds(2),
        )

    private fun expectedUrl(pageNumber: Int) =
        BASE_URL + PATH +
            "?serviceKey=abc%2Bdef%3D" +
            "&pageNo=$pageNumber" +
            "&numOfRows=1000" +
            "&dataType=json"

    private fun wrappedPage(
        totalCount: Int,
        id: String,
        pageSize: Int = 1_000,
    ) =
        """
        {
          "response": {
            "header": {"resultCode": "00", "resultMsg": "NORMAL_SERVICE"},
            "body": {
              "items": {"item": [${item(id)}]},
              "numOfRows": $pageSize,
              "pageNo": 1,
              "totalCount": $totalCount
            }
          }
        }
        """.trimIndent()

    private fun directItemsPage(
        totalCount: Int,
        id: String,
        pageSize: Int = 1_000,
    ) =
        """
        {
          "response": {
            "header": {"resultCode": "00", "resultMsg": "NORMAL_SERVICE"},
            "body": {
              "items": [${item(id)}],
              "numOfRows": $pageSize,
              "pageNo": 2,
              "totalCount": $totalCount
            }
          }
        }
        """.trimIndent()

    private fun wrappedSingleItemPage(totalCount: Int, id: String) =
        """
        {
          "response": {
            "header": {"resultCode": "00", "resultMsg": "NORMAL_SERVICE"},
            "body": {
              "items": {"item": ${item(id)}},
              "numOfRows": 1000,
              "pageNo": 1,
              "totalCount": $totalCount
            }
          }
        }
        """.trimIndent()

    private fun pageWithoutItems(totalCount: Int) =
        """
        {
          "response": {
            "header": {"resultCode": "00", "resultMsg": "NORMAL_SERVICE"},
            "body": {"pageNo": 1, "numOfRows": 1000, "totalCount": $totalCount}
          }
        }
        """.trimIndent()

    private fun pageWithItems(
        totalCount: Int,
        items: String,
        pageSize: Int = 1_000,
    ) =
        """
        {
          "response": {
            "header": {"resultCode": "00", "resultMsg": "NORMAL_SERVICE"},
            "body": {
              "items": $items,
              "pageNo": 1,
              "numOfRows": $pageSize,
              "totalCount": $totalCount
            }
          }
        }
        """.trimIndent()

    private fun item(id: String) =
        """
        {
          "pblancNm": "서울 AI 사업",
          "pblancUrl": "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=$id",
          "pblancId": "$id",
          "excInsttNm": "수행기관",
          "bsnsSumryCn": "<p>설명</p>",
          "pldirSportRealmLclasCodeNm": "기술",
          "reqstBeginEndDe": "2026-08-01 ~ 2026-09-01",
          "trgetNm": "중소기업",
          "hashtags": "기술,서울"
        }
        """.trimIndent()

    private companion object {
        const val BASE_URL = "https://public-data.test"
        const val PATH = "/1421000/bizinfo/pblancBsnsService"
        const val ENCODED_KEY = "abc%2Bdef%3D"
    }
}
