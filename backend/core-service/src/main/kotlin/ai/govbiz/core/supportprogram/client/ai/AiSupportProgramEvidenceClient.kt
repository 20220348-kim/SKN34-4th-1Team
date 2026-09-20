package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.helper.executeAiServiceCall
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceAnswerPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceAnswerRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceIndexPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceIndexRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceSearchPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceSearchRequest
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** AI Service의 공고 원문 근거 청크 색인·검색·답변 HTTP 계약을 소유합니다. */
@Component
class AiSupportProgramEvidenceClient(
    @param:Qualifier("aiSemanticSearchRestClient") private val semanticSearchRestClient: RestClient,
    @param:Qualifier("aiServiceRestClient") private val answerRestClient: RestClient,
) {
    fun indexChunks(request: AiSupportProgramEvidenceIndexRequest): AiSupportProgramEvidenceIndexPayload =
        execute(
            restClient = semanticSearchRestClient,
            method = HttpMethod.PUT,
            operation = "chunks",
            request = request,
            responseType = AiSupportProgramEvidenceIndexPayload::class.java,
        )

    fun searchChunks(request: AiSupportProgramEvidenceSearchRequest): AiSupportProgramEvidenceSearchPayload =
        execute(
            restClient = semanticSearchRestClient,
            method = HttpMethod.POST,
            operation = "search",
            request = request,
            responseType = AiSupportProgramEvidenceSearchPayload::class.java,
        )

    fun answer(request: AiSupportProgramEvidenceAnswerRequest): AiSupportProgramEvidenceAnswerPayload =
        execute(
            restClient = answerRestClient,
            method = HttpMethod.POST,
            operation = "answers",
            request = request,
            responseType = AiSupportProgramEvidenceAnswerPayload::class.java,
        )

    private fun <T : Any> execute(
        restClient: RestClient,
        method: HttpMethod,
        operation: String,
        request: Any,
        responseType: Class<T>,
    ): T =
        executeAiServiceCall {
            restClient.method(method)
                .uri("/internal/v1/support-program-evidence/$operation")
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .onStatus(
                    { it.value() != HttpStatus.OK.value() },
                    { _, response ->
                        when (val status = response.statusCode.value()) {
                            HttpStatus.NO_CONTENT.value() ->
                                throw AiServiceCallException.invalidResponse("AI evidence response was empty", null)
                            HttpStatus.SERVICE_UNAVAILABLE.value() ->
                                throw AiServiceCallException.unavailable(null)
                            HttpStatus.REQUEST_TIMEOUT.value(), HttpStatus.GATEWAY_TIMEOUT.value() ->
                                throw AiServiceCallException.timeout(null)
                            else ->
                                throw AiServiceCallException.upstreamError(
                                    "AI evidence returned HTTP $status",
                                    null,
                                )
                        }
                    },
                )
                .toEntity(responseType)
                .body
                ?: throw AiServiceCallException.invalidResponse("AI evidence response was empty", null)
        }
}
