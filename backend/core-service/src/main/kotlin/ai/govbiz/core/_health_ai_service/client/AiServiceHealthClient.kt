package ai.govbiz.core._health_ai_service.client

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.helper.executeAiServiceCall
import ai.govbiz.core._health_ai_service.client.dto.AiServiceHealthPayload
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** AI Service의 상태 확인 API만 호출하는 HTTP 클라이언트입니다. */
@Component
class AiServiceHealthClient(
    @param:Qualifier("aiServiceRestClient") private val restClient: RestClient,
) {
    fun getHealth(): AiServiceHealthPayload =
        executeAiServiceCall {
            val response = restClient.get()
                .uri(HEALTH_PATH)
                .retrieve()
                .onStatus(
                    { statusCode -> statusCode.value() != HttpStatus.OK.value() },
                    { _, clientResponse ->
                        val statusCode = clientResponse.statusCode.value()
                        if (statusCode == HttpStatus.NO_CONTENT.value()) {
                            throw AiServiceCallException.invalidResponse(
                                "AI Service returned HTTP 204 without a health response",
                                null,
                            )
                        }
                        if (statusCode == HttpStatus.SERVICE_UNAVAILABLE.value()) {
                            throw AiServiceCallException.unavailable(null)
                        }
                        throw AiServiceCallException.upstreamError(
                            "AI Service returned unexpected HTTP $statusCode",
                            null,
                        )
                    },
                )
                .toEntity(AiServiceHealthPayload::class.java)

            response.body
                ?: throw AiServiceCallException.invalidResponse(
                    "AI Service returned an empty health response",
                    null,
                )
        }

    private companion object {
        const val HEALTH_PATH = "/internal/v1/health"
    }
}
