package ai.govbiz.core.account.client.bizno

import ai.govbiz.core.account.client.bizno.config.BiznoClientProperties
import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness
import ai.govbiz.core.account.client.bizno.exception.BiznoClientException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URI
import java.time.Duration
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.ResponseCreator
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withException
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class BiznoClientTest {

    private lateinit var server: MockRestServiceServer
    private lateinit var client: BiznoClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder().baseUrl(BASE_URL)
        server = MockRestServiceServer.bindTo(builder).build()
        client = BiznoClient(builder.build(), properties(API_KEY))
    }

    @AfterEach
    fun verifiesEveryExpectedRequest() {
        server.verify()
    }

    @Test
    fun sendsExactLookupRequestAndReturnsRegisteredBusinessesWithoutNullSlots() {
        server.expect(requestTo(LOOKUP_URL))
            .andExpect(method(HttpMethod.GET))
            .andRespond(withSuccess(REGISTERED_RESPONSE, MediaType.APPLICATION_JSON))

        val businesses = client.findByBusinessNumber(BUSINESS_NUMBER)

        assertEquals(
            listOf(
                BiznoBusiness(
                    businessNumber = BUSINESS_NUMBER,
                    companyName = "삼성전자(주)",
                    businessStatus = "계속사업자",
                    businessStatusCode = "01",
                ),
            ),
            businesses,
        )
        assertTrue(businesses.single().isActive)
    }

    @Test
    fun keepsClosedBusinessesWithTheirStatusSoTheServiceCanRejectThem() {
        expectResponse(
            withSuccess(
                """{"resultCode":0,"items":[{"company":"문 닫은 회사","bno":"124-81-00998","cno":"","bsttcd":"03",
                   "bstt":"폐업자","TaxTypeCd":"","taxtype":"","EndDt":"20240131"}]}""",
                MediaType.APPLICATION_JSON,
            ),
        )

        val business = client.findByBusinessNumber(BUSINESS_NUMBER).single()

        assertFalse(business.isActive)
        assertEquals("폐업자", business.businessStatus)
        assertEquals("03", business.businessStatusCode)
    }

    @Test
    fun treatsMissingItemsAsNoResult() {
        expectResponse(withSuccess("""{"resultCode":0,"resultMsg":"NORMAL SERVICE.","totalCount":0}""", MediaType.APPLICATION_JSON))

        assertEquals(emptyList<BiznoBusiness>(), client.findByBusinessNumber(BUSINESS_NUMBER))
    }

    @Test
    fun excludesEntriesWithoutABusinessStatusCodeBecauseTheyAreNotRegistered() {
        server.expect(requestTo(lookupUrl(UNREGISTERED_NUMBER)))
            .andRespond(withSuccess(UNREGISTERED_RESPONSE, MediaType.APPLICATION_JSON))

        assertEquals(emptyList<BiznoBusiness>(), client.findByBusinessNumber(UNREGISTERED_NUMBER))
    }

    @Test
    fun excludesEntriesForADifferentBusinessNumber() {
        expectResponse(
            withSuccess(
                """{"resultCode":0,"items":[{"company":"다른 회사","bno":"999-99-99999","bsttcd":"01","bstt":"계속사업자"}]}""",
                MediaType.APPLICATION_JSON,
            ),
        )

        assertEquals(emptyList<BiznoBusiness>(), client.findByBusinessNumber(BUSINESS_NUMBER))
    }

    @Test
    fun mapsNonZeroResultCodeToUpstreamError() {
        expectResponse(
            withSuccess(
                """{"resultCode":-1,"resultMsg":"미등록 사용자입니다.","totalCount":0,"items":""}""",
                MediaType.APPLICATION_JSON,
            ),
        )

        assertFailure(BiznoClientException.Failure.UPSTREAM_ERROR)
    }

    @Test
    fun mapsNonArrayItemsToInvalidResponse() {
        expectResponse(withSuccess("""{"resultCode":0,"items":"unexpected"}""", MediaType.APPLICATION_JSON))

        assertFailure(BiznoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun mapsItemWithoutBusinessNumberToInvalidResponse() {
        expectResponse(
            withSuccess("""{"resultCode":0,"items":[{"company":"회사","bsttcd":"01"}]}""", MediaType.APPLICATION_JSON),
        )

        assertFailure(BiznoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun mapsMissingResultCodeToInvalidResponse() {
        expectResponse(withSuccess("""{"items":[]}""", MediaType.APPLICATION_JSON))

        assertFailure(BiznoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun mapsMalformedJsonToInvalidResponse() {
        expectResponse(withSuccess("""{"resultCode":""", MediaType.APPLICATION_JSON))

        assertFailure(BiznoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun mapsEmptyBodyToInvalidResponse() {
        expectResponse(withSuccess("", MediaType.APPLICATION_JSON))

        assertFailure(BiznoClientException.Failure.INVALID_RESPONSE)
    }

    @Test
    fun mapsUnexpectedHttpStatusToUpstreamError() {
        expectResponse(withStatus(HttpStatus.INTERNAL_SERVER_ERROR).contentType(MediaType.TEXT_PLAIN).body("error"))

        assertFailure(BiznoClientException.Failure.UPSTREAM_ERROR)
    }

    @Test
    fun mapsConnectionFailureToUnavailableWithoutLeakingTheApiKey() {
        expectResponse(withException(ConnectException("connection refused")))

        val exception = assertFailure(BiznoClientException.Failure.UNAVAILABLE)

        assertFalse(exception.message.orEmpty().contains(API_KEY))
        assertFalse(exception.cause?.message.orEmpty().contains(API_KEY))
    }

    @Test
    fun mapsReadTimeoutToTimeout() {
        expectResponse(withException(SocketTimeoutException("read timeout")))

        assertFailure(BiznoClientException.Failure.TIMEOUT)
    }

    @Test
    fun rejectsLookupWithoutAnApiKeyBeforeSendingAnyRequest() {
        val builder = RestClient.builder().baseUrl(BASE_URL)
        val unconfiguredServer = MockRestServiceServer.bindTo(builder).build()
        val unconfiguredClient = BiznoClient(builder.build(), properties(""))

        val exception = assertThrows(BiznoClientException::class.java) {
            unconfiguredClient.findByBusinessNumber(BUSINESS_NUMBER)
        }

        assertEquals(BiznoClientException.Failure.NOT_CONFIGURED, exception.failure)
        unconfiguredServer.verify()
    }

    @Test
    fun rejectsABusinessNumberThatIsNotTenDigits() {
        assertThrows(IllegalArgumentException::class.java) {
            client.findByBusinessNumber("124-81-00998")
        }
    }

    private fun expectResponse(response: ResponseCreator) {
        server.expect(requestTo(LOOKUP_URL)).andRespond(response)
    }

    private fun assertFailure(expectedFailure: BiznoClientException.Failure): BiznoClientException {
        val exception = assertThrows(BiznoClientException::class.java) {
            client.findByBusinessNumber(BUSINESS_NUMBER)
        }
        assertEquals(expectedFailure, exception.failure)
        return exception
    }

    private fun properties(apiKey: String) =
        BiznoClientProperties(
            URI.create("$BASE_URL/api/fapi"),
            apiKey,
            Duration.ofSeconds(1),
            Duration.ofSeconds(2),
        )

    private companion object {
        const val BASE_URL = "https://bizno.test"
        const val API_KEY = "secret-api-key"
        const val BUSINESS_NUMBER = "1248100998"
        const val UNREGISTERED_NUMBER = "1234567890"
        val LOOKUP_URL = lookupUrl(BUSINESS_NUMBER)

        fun lookupUrl(businessNumber: String) =
            "$BASE_URL/api/fapi?key=$API_KEY&gb=1&q=$businessNumber&type=json"

        val REGISTERED_RESPONSE =
            """
            {"resultCode":0,"resultMsg":"NORMAL SERVICE.","page":1,"maxpage":1,"pagecnt":10,"totalCount":1,
             "items":[{"company":"삼성전자(주)","bno":"124-81-00998","cno":"130111-0006246","bsttcd":"01",
                       "bstt":"계속사업자","TaxTypeCd":"","taxtype":"부가가치세 일반과세자","EndDt":""},
                      null,null,null,null,null,null,null,null,null]}
            """.trimIndent()

        val UNREGISTERED_RESPONSE =
            """
            {"resultCode":0,"resultMsg":"NORMAL SERVICE.","page":1,"maxpage":1,"pagecnt":10,"totalCount":1,
             "items":[{"company":"퍼피또리(puppyddory)","bno":"123-45-67890","cno":"","bsttcd":"","bstt":"",
                       "TaxTypeCd":"","taxtype":"국세청에 등록되지 않은 사업자등록번호입니다.","EndDt":""},
                      null,null,null,null,null,null,null,null,null]}
            """.trimIndent()
    }
}
