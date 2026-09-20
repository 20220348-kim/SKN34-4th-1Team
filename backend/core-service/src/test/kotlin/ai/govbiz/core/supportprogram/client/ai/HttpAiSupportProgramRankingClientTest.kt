package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramCandidateRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEligibility
import ai.govbiz.core.supportprogram.client.ai.dto.AiScoredSupportProgramPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramCompanyConditionsRequest
import org.hamcrest.Matchers.containsString
import org.hamcrest.Matchers.not
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withNoContent
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class HttpAiSupportProgramRankingClientTest {

    private lateinit var server: MockRestServiceServer
    private lateinit var client: HttpAiSupportProgramRankingClient

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder()
            .baseUrl(BASE_URL)
            .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
        server = MockRestServiceServer.bindTo(builder).build()
        client = HttpAiSupportProgramRankingClient(builder.build())
    }

    @AfterEach
    fun verifiesEveryExpectedRequest() {
        server.verify()
    }

    @Test
    fun sendsExactRankingRequestAndDecodesTheStructuredScores() {
        server.expect(requestTo(RANKING_URL))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().string(not(containsString("companyConditions"))))
            .andExpect(header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE))
            .andExpect(header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE))
            .andExpect(
                content().json(
                    """
                    {
                      "originalQuery":"서울 AI 스타트업 지원사업",
                      "scoringVersion":"govbiz-support-program-ranking-v5",
                      "resultLimit":1,
                      "candidates":[{
                        "id":"BIZINFO:program-1",
                        "title":"서울 AI 사업화 지원",
                        "organization":"서울경제진흥원",
                        "summary":"AI 창업기업 사업화 지원",
                        "categories":["AI","창업"],
                        "regions":["서울"],
                        "targetDescription":"서울 창업기업",
                        "applicationPeriod":"상시 접수",
                        "status":"OPEN",
                        "sourceTextTruncated":false
                      }]
                    }
                    """.trimIndent(),
                ),
            )
            .andRespond(withSuccess(VALID_RANKING_RESPONSE, MediaType.APPLICATION_JSON))

        val response = client.rankSupportPrograms(rankingRequest())

        assertEquals("서울 AI 스타트업 지원사업", response.originalQuery)
        assertEquals(92, response.rankings?.single()?.totalScore)
        assertEquals("BIZINFO:program-1", response.rankings?.single()?.programId)
        assertEquals(AiSupportProgramEligibility.MATCH, response.rankings?.single()?.targetEligibility)
        assertEquals(AiSupportProgramEligibility.MATCH, response.rankings?.single()?.regionEligibility)
        assertEquals("서울 창업기업", response.rankings?.single()?.targetEvidence?.single()?.quote)
        assertEquals("공식 API 지원대상에 창업기업이 명시되어 있습니다.", response.rankings?.single()?.targetExplanation)
    }

    @Test
    fun sendsOptionalCompanyConditionsAsStructuredJsonWithIsoDates() {
        server.expect(requestTo(RANKING_URL))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().json("""{
              "originalQuery":"서울 AI 스타트업 지원사업",
              "companyConditions":{
                "region":"서울","industry":"제조업","establishedOn":"2024-02-29",
                "supportPurpose":"시제품 제작","referenceDate":"2026-09-07"
              }
            }"""))
            .andRespond(withSuccess(VALID_RANKING_RESPONSE, MediaType.APPLICATION_JSON))
        client.rankSupportPrograms(rankingRequest().copy(
            companyConditions = AiSupportProgramCompanyConditionsRequest("서울", "제조업", "2024-02-29", "시제품 제작", "2026-09-07"),
        ))
    }

    @Test
    fun decodesAnEmptyRankingAsAValidSuccessfulResponse() {
        server.expect(requestTo(RANKING_URL))
            .andRespond(withSuccess(EMPTY_RANKING_RESPONSE, MediaType.APPLICATION_JSON))

        val response = client.rankSupportPrograms(rankingRequest())

        assertEquals(emptyList<AiScoredSupportProgramPayload?>(), response.rankings)
    }

    @Test
    fun mapsRankingNoContentToInvalidResponse() {
        server.expect(requestTo(RANKING_URL)).andRespond(withNoContent())

        assertRankingFailure(AiServiceFailure.INVALID_RESPONSE)
    }

    @Test
    fun mapsMalformedRankingJsonToInvalidResponse() {
        server.expect(requestTo(RANKING_URL))
            .andRespond(withSuccess("{\"rankings\":", MediaType.APPLICATION_JSON))

        assertRankingFailure(AiServiceFailure.INVALID_RESPONSE)
    }

    @Test
    fun mapsRankingUnavailableStatusToUnavailable() {
        server.expect(requestTo(RANKING_URL))
            .andRespond(
                withStatus(HttpStatus.SERVICE_UNAVAILABLE)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"detail\":\"unavailable\"}"),
            )

        assertRankingFailure(AiServiceFailure.UNAVAILABLE)
    }

    @Test
    fun mapsRankingGatewayTimeoutStatusToTimeout() {
        server.expect(requestTo(RANKING_URL))
            .andRespond(
                withStatus(HttpStatus.GATEWAY_TIMEOUT)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"detail\":\"timeout\"}"),
            )

        val exception = assertThrows(AiServiceCallException::class.java) {
            client.rankSupportPrograms(rankingRequest())
        }
        assertEquals(AiServiceFailure.TIMEOUT, exception.failure)
        val publicResponse = ApiExceptionHandler().handleAiServiceCallException(
            exception, MockHttpServletRequest("POST", "/api/v1/support-programs/search"),
        )
        assertEquals(HttpStatus.GATEWAY_TIMEOUT, publicResponse.statusCode)
        assertEquals("AI_SERVICE_TIMEOUT", publicResponse.body!!.properties!!["code"])
    }

    private fun assertRankingFailure(expectedFailure: AiServiceFailure) {
        val exception = assertThrows(AiServiceCallException::class.java) {
            client.rankSupportPrograms(rankingRequest())
        }
        assertEquals(expectedFailure, exception.failure)
    }

    private fun rankingRequest() = AiSupportProgramRankingRequest(
        originalQuery = "서울 AI 스타트업 지원사업",
        scoringVersion = "govbiz-support-program-ranking-v5",
        resultLimit = 1,
        candidates = listOf(
            AiSupportProgramCandidateRequest(
                id = "BIZINFO:program-1",
                title = "서울 AI 사업화 지원",
                organization = "서울경제진흥원",
                summary = "AI 창업기업 사업화 지원",
                categories = listOf("AI", "창업"),
                regions = listOf("서울"),
                targetDescription = "서울 창업기업",
                applicationPeriod = "상시 접수",
                status = "OPEN",
            ),
        ),
    )

    private companion object {
        const val BASE_URL = "http://ai-service.test:8000"
        const val RANKING_URL = "$BASE_URL/internal/v1/support-program-rankings/rank"
        val VALID_RANKING_RESPONSE =
            """
            {
              "originalQuery":"서울 AI 스타트업 지원사업",
              "scoringVersion":"govbiz-support-program-ranking-v5",
              "rankings":[{
                "programId":"BIZINFO:program-1",
                "semanticRelevance":38,
                "targetEligibility":"MATCH",
                "regionEligibility":"MATCH",
                "supportTypeFit":8,
                "totalScore":92,
                "recommendationReasons":["서울 AI 창업기업 사업화 지원"],
                "targetEvidence":[{"field":"TARGET_DESCRIPTION","quote":"서울 창업기업"}],
                "targetExplanation":"공식 API 지원대상에 창업기업이 명시되어 있습니다.",
                "regionEvidence":[{"field":"TARGET_DESCRIPTION","quote":"서울 창업기업"}],
                "regionExplanation":"공식 API 지원대상에 서울 소재 요건이 명시되어 있습니다."
              }]
            }
            """.trimIndent()
        val EMPTY_RANKING_RESPONSE =
            """
            {
              "originalQuery":"서울 AI 스타트업 지원사업",
              "scoringVersion":"govbiz-support-program-ranking-v5",
              "rankings":[]
            }
            """.trimIndent()
    }
}
