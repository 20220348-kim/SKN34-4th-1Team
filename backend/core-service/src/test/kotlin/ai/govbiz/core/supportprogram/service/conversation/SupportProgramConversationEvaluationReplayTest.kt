package ai.govbiz.core.supportprogram.service.conversation

import ai.govbiz.core._common.config.JsonDeserializationConfig
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramConversationClient
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramConversationRequest
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationClarificationKind
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationField
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationStatus
import ai.govbiz.core.supportprogram.service.dto.SupportProgramConversationResult
import java.time.Clock
import java.time.LocalDate
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import org.springframework.test.json.JsonCompareMode
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.*
import org.springframework.test.web.client.response.MockRestResponseCreators.*
import org.springframework.web.client.RestClient
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import tools.jackson.module.kotlin.KotlinModule

/**
 * 대화 조건 해석 평가의 replay.py가 기록한 AI Service 응답(evaluation/support-program-conversation/runs/example)을
 * 실제 Client·Service로 다시 받아 Core의 수락·거부를 확인합니다. 손으로 만든 예시 출력이며 모델 품질 측정이 아닙니다.
 */
class SupportProgramConversationEvaluationReplayTest {
    private val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).also {
        JsonDeserializationConfig().strictJsonRequestTypes().customize(it)
    }.build()
    private val records: Map<String, JsonNode> = mapper.readTree(
        requireNotNull(javaClass.getResourceAsStream("/support-program-conversation/example-ai-responses.json")),
    )["records"].associateBy { "${it["caseId"].asString()}#${it["turn"].asInt()}" }

    @Test
    fun fixtureHoldsAcceptedAndRejectedAiServiceResponses() {
        assertEquals(setOf("S002#1", "S032#1", "M14#1"), records.keys)
        assertEquals(listOf(200, 200, 503), records.values.map { it["httpStatus"].asInt() }.sorted())
    }

    @Test
    fun keepsTheRegisteredRegionSpellingWhenTheRecordedReadyOnlyRewritesTheSameRegion() {
        val result = interpret("S002#1")

        assertEquals(SupportProgramConversationStatus.READY, result.status)
        assertEquals("AI 창업지원", result.proposedContext.query)
        // AI Service는 표기만 다른 "서울"을 통과시키며, Core 지역 사전이 등록 표기를 유지해 변경으로 세지 않습니다.
        assertEquals("서울특별시", result.proposedContext.companyConditions.region)
        assertEquals("정보통신업", result.proposedContext.companyConditions.industry)
        assertEquals(2021, result.proposedContext.companyConditions.foundedYear)
        assertEquals(listOf(SupportProgramConversationField.QUERY), result.changedFields)
        assertNull(result.clarificationKind)
    }

    @Test
    fun passesTheRecordedClarificationDraftAndQuestionKind() {
        val result = interpret("M14#1")

        assertEquals(SupportProgramConversationStatus.CLARIFICATION_REQUIRED, result.status)
        assertEquals(SupportProgramConversationClarificationKind.REGION, result.clarificationKind)
        assertEquals(records.getValue("M14#1")["response"]["clarificationQuestion"].asString(), result.clarificationQuestion)
        assertEquals("수출 지원", result.proposedContext.query)
        assertNull(result.proposedContext.companyConditions.region)
        assertEquals(listOf(SupportProgramConversationField.QUERY), result.changedFields)
    }

    @Test
    fun reportsTheRecordedValidatorRejectionAsUnavailableWithoutAFallbackResult() {
        val error = assertThrows(AiServiceCallException::class.java) { interpret("S032#1") }

        assertEquals(AiServiceFailure.UNAVAILABLE, error.failure)
    }

    /** 기록된 요청을 공개 계약으로 되돌려 실제 Service를 실행합니다. Core가 보낸 내부 요청은 기록과 엄격히 같아야 합니다. */
    private fun interpret(key: String): SupportProgramConversationResult {
        val record = records.getValue(key)
        val recorded = record["request"]
        val builder = RestClient.builder().baseUrl(AI_SERVICE)
            .messageConverters { it.clear(); it.add(JacksonJsonHttpMessageConverter(mapper)) }
        val server = MockRestServiceServer.bindTo(builder).build()
        server.expect(requestTo("$AI_SERVICE/internal/v1/support-program-conversation/interpret"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().json(mapper.writeValueAsString(recorded), JsonCompareMode.STRICT))
            .andRespond(
                withStatus(HttpStatus.valueOf(record["httpStatus"].asInt()))
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(mapper.writeValueAsString(record["response"])),
            )
        val referenceDate = LocalDate.parse(recorded["referenceDate"].asString())
        val clock = Clock.fixed(referenceDate.atTime(12, 0).atZone(SEOUL).toInstant(), SEOUL)
        val request = mapper.treeToValue(
            (recorded.deepCopy() as ObjectNode).apply {
                remove("schemaVersion")
                remove("referenceDate")
            },
            SupportProgramConversationRequest::class.java,
        )
        try {
            return SupportProgramConversationService(AiSupportProgramConversationClient(builder.build()), clock).interpret(
                request.message,
                request.context.toDomain(),
                request.pendingClarification?.toDomain(),
                request.pendingProposal?.toDomain(),
                request.lastSearch?.toDomain(),
            )
        } finally {
            server.verify()
        }
    }

    private companion object {
        const val AI_SERVICE = "http://ai-service.test"
        val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")
    }
}
