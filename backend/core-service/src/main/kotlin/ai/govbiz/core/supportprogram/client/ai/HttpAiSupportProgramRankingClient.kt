package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.helper.executeAiServiceCall
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** 지원사업 후보의 AI 점수화 API를 호출하는 HTTP 어댑터입니다. */
@Component
class HttpAiSupportProgramRankingClient(
    @param:Qualifier("aiRankingRestClient") private val restClient: RestClient,
) : AiSupportProgramRankingClient {
    override fun rankSupportPrograms(
        request: AiSupportProgramRankingRequest,
    ): AiSupportProgramRankingPayload =
        executeAiServiceCall {
            val response = restClient.post()
                .uri(SUPPORT_PROGRAM_RANKING_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .onStatus(
                    { statusCode -> statusCode.value() != HttpStatus.OK.value() },
                    { _, clientResponse ->
                        val statusCode = clientResponse.statusCode.value()
                        if (statusCode == HttpStatus.NO_CONTENT.value()) {
                            throw AiServiceCallException.invalidResponse(
                                "AI Service returned HTTP 204 without support program rankings",
                                null,
                            )
                        }
                        if (statusCode == HttpStatus.SERVICE_UNAVAILABLE.value()) {
                            throw AiServiceCallException.unavailable(null)
                        }
                        if (
                            statusCode == HttpStatus.REQUEST_TIMEOUT.value() ||
                            statusCode == HttpStatus.GATEWAY_TIMEOUT.value()
                        ) {
                            throw AiServiceCallException.timeout(null)
                        }
                        throw AiServiceCallException.upstreamError(
                            "AI Service returned unexpected HTTP $statusCode",
                            null,
                        )
                    },
                )
                .toEntity(AiSupportProgramRankingPayload::class.java)

            response.body
                ?: throw AiServiceCallException.invalidResponse(
                    "AI Service returned an empty support program ranking response",
                    null,
                )
        }

    private companion object {
        const val SUPPORT_PROGRAM_RANKING_PATH =
            "/internal/v1/support-program-rankings/rank"
    }
}
