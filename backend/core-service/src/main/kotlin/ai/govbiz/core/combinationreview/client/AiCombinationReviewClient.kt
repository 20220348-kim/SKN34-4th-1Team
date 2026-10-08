package ai.govbiz.core.combinationreview.client

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.helper.executeAiServiceCall
import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewPayload
import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewRequest
import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewV3Payload
import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewV3Request
import ai.govbiz.core.combinationreview.client.dto.AiReviewConfigurationPayload
import ai.govbiz.core.combinationreview.client.exception.AiCombinationReviewClientException
import ai.govbiz.core.combinationreview.client.exception.AiCombinationReviewClientException.Reason
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.http.client.ClientHttpResponse
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.databind.ObjectMapper

@Component
class AiCombinationReviewClient(@param:Qualifier("aiCombinationReviewRestClient") private val client: RestClient, private val json: ObjectMapper) {
    /** contractVersion이 없으면 기존 v2 설정을 읽는다. v3는 `?contractVersion=combination-review-v3`로 묻는다. */
    fun configuration(contractVersion: String? = null): AiReviewConfigurationPayload = executeAiServiceCall {
        val request = if (contractVersion == null) client.get().uri(CONFIGURATION_PATH)
        else client.get().uri("$CONFIGURATION_PATH?contractVersion={contractVersion}", contractVersion)
        request.retrieve()
            .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.unavailable(null) })
            .body(AiReviewConfigurationPayload::class.java)
            ?: throw AiCombinationReviewClientException(Reason.INVALID_RESPONSE)
    }

    fun analyze(request: AiCombinationReviewRequest): AiCombinationReviewPayload = post(request, AiCombinationReviewPayload::class.java)

    fun analyzeV3(request: AiCombinationReviewV3Request): AiCombinationReviewV3Payload = post(request, AiCombinationReviewV3Payload::class.java)

    /** v2·v3는 같은 분석 경로와 오류 계약을 쓰며 요청·응답 본문만 다르다. */
    private fun <T : Any> post(request: Any, type: Class<T>): T = executeAiServiceCall {
        client.post().uri("/internal/v1/combination-reviews/analyze").contentType(MediaType.APPLICATION_JSON)
            .body(request).retrieve()
            .onStatus({ it.value() == 422 }, { _, response ->
                val tooLarge = readErrorCode(response) == "CONTEXT_TOO_LARGE"
                throw AiCombinationReviewClientException(if (tooLarge) Reason.CONTEXT_TOO_LARGE else Reason.INVALID_RESPONSE)
            })
            .onStatus({ it.value() == 503 }, { _, response ->
                if (readErrorCode(response) == "COMBINATION_REVIEW_FAILED") {
                    throw AiCombinationReviewClientException(Reason.INVALID_RESPONSE)
                }
                throw AiServiceCallException.unavailable(null)
            })
            .onStatus({ it.value() == 504 }, { _, _ -> throw AiServiceCallException.timeout(null) })
            .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.unavailable(null) })
            .body(type)
            ?: throw AiCombinationReviewClientException(Reason.INVALID_RESPONSE)
    }

    private fun readErrorCode(response: ClientHttpResponse): String? {
        val bytes = response.body.readNBytes(8193)
        if (bytes.size > 8192) return null
        return runCatching { json.readTree(bytes).path("detail").path("code").asString() }.getOrNull()
    }

    private companion object {
        const val CONFIGURATION_PATH = "/internal/v1/combination-reviews/configuration"
    }
}
