package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.helper.executeAiServiceCall
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexBatchPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexBatchRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexPrunePayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexPruneRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexSearchPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexSearchRequest
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** AI Service의 공고 벡터 색인·검색 HTTP 계약을 소유합니다. */
@Component
class AiSupportProgramIndexClient(
    @param:Qualifier("aiSemanticSearchRestClient") private val restClient: RestClient,
) {
    fun indexBatch(request: AiSupportProgramIndexBatchRequest): AiSupportProgramIndexBatchPayload =
        execute(HttpMethod.PUT, "batch", request, AiSupportProgramIndexBatchPayload::class.java)

    fun prune(request: AiSupportProgramIndexPruneRequest): AiSupportProgramIndexPrunePayload =
        execute(HttpMethod.POST, "prune", request, AiSupportProgramIndexPrunePayload::class.java)

    fun search(request: AiSupportProgramIndexSearchRequest): AiSupportProgramIndexSearchPayload =
        execute(HttpMethod.POST, "search", request, AiSupportProgramIndexSearchPayload::class.java)

    private fun <T : Any> execute(method: HttpMethod, operation: String, request: Any, responseType: Class<T>): T =
        executeAiServiceCall {
            restClient.method(method)
                .uri("/internal/v1/support-program-index/$operation")
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .onStatus(
                    { it.value() != HttpStatus.OK.value() },
                    { _, response ->
                        when (val status = response.statusCode.value()) {
                            HttpStatus.NO_CONTENT.value() ->
                                throw AiServiceCallException.invalidResponse("AI index response was empty", null)
                            HttpStatus.SERVICE_UNAVAILABLE.value() -> throw AiServiceCallException.unavailable(null)
                            HttpStatus.REQUEST_TIMEOUT.value(), HttpStatus.GATEWAY_TIMEOUT.value() ->
                                throw AiServiceCallException.timeout(null)
                            else -> throw AiServiceCallException.upstreamError("AI index returned HTTP $status", null)
                        }
                    },
                )
                .toEntity(responseType).body
                ?: throw AiServiceCallException.invalidResponse("AI index response was empty", null)
        }
}
