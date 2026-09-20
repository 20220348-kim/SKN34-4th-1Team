package ai.govbiz.core.assistant.client

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.helper.executeAiServiceCall
import ai.govbiz.core.assistant.client.dto.AiAssistantAgentPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantAgentRequest
import ai.govbiz.core.assistant.client.dto.AiAssistantAnswerPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantAnswerRequest
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/**
 * 도우미 자유 질문을 AI Service에 한 번 요청합니다. `answer`는 의도 분류만, `agent`는 분류 뒤 Core 내부 도구를 부르는
 * LangGraph 경로입니다. 검색·조회·저장은 하지 않습니다.
 */
@Component
class AiAssistantClient(
    @param:Qualifier("aiServiceRestClient") private val restClient: RestClient,
) {
    fun answer(request: AiAssistantAnswerRequest): AiAssistantAnswerPayload =
        executeAiServiceCall { post(ANSWERS_PATH, request).toEntity(AiAssistantAnswerPayload::class.java).body ?: empty() }

    fun agent(request: AiAssistantAgentRequest): AiAssistantAgentPayload =
        executeAiServiceCall { post(AGENT_PATH, request).toEntity(AiAssistantAgentPayload::class.java).body ?: empty() }

    private fun post(path: String, request: Any): RestClient.ResponseSpec =
        restClient.post()
            .uri(path)
            .contentType(MediaType.APPLICATION_JSON)
            .body(request)
            .retrieve()
            .onStatus(
                { it.value() != HttpStatus.OK.value() },
                { _, response ->
                    when (val status = response.statusCode.value()) {
                        HttpStatus.NO_CONTENT.value() -> empty()
                        HttpStatus.SERVICE_UNAVAILABLE.value() -> throw AiServiceCallException.unavailable(null)
                        HttpStatus.REQUEST_TIMEOUT.value(), HttpStatus.GATEWAY_TIMEOUT.value() ->
                            throw AiServiceCallException.timeout(null)
                        else -> throw AiServiceCallException.upstreamError("AI assistant returned HTTP $status", null)
                    }
                },
            )

    private fun empty(): Nothing = throw AiServiceCallException.invalidResponse("AI assistant response was empty", null)

    companion object {
        const val ANSWERS_PATH = "/internal/v1/assistant/answers"
        const val AGENT_PATH = "/internal/v1/assistant/agent"
    }
}
