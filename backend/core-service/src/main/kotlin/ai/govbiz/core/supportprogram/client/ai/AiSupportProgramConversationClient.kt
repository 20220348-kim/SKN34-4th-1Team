package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.helper.executeAiServiceCall
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationRequest
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** 대화 조건 변경·맥락 설명을 호출하며 검색·색인·공고 조회를 수행하지 않습니다. */
@Component
class AiSupportProgramConversationClient(
    @param:Qualifier("aiServiceRestClient") private val restClient: RestClient,
) {
    fun interpret(request: AiSupportProgramConversationRequest): AiSupportProgramConversationPayload =
        executeAiServiceCall {
            restClient.post()
                .uri("/internal/v1/support-program-conversation/interpret")
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .onStatus(
                    { it.value() != HttpStatus.OK.value() },
                    { _, response ->
                        when (val status = response.statusCode.value()) {
                            HttpStatus.NO_CONTENT.value() ->
                                throw AiServiceCallException.invalidResponse("AI conversation response was empty", null)
                            HttpStatus.SERVICE_UNAVAILABLE.value() -> throw AiServiceCallException.unavailable(null)
                            HttpStatus.REQUEST_TIMEOUT.value(), HttpStatus.GATEWAY_TIMEOUT.value() ->
                                throw AiServiceCallException.timeout(null)
                            else -> throw AiServiceCallException.upstreamError("AI conversation returned HTTP $status", null)
                        }
                    },
                )
                .toEntity(AiSupportProgramConversationPayload::class.java)
                .body
                ?: throw AiServiceCallException.invalidResponse("AI conversation response was empty", null)
        }
}
