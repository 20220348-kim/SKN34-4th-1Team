package ai.govbiz.core._health_ai_service.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._health_ai_service.client.AiServiceHealthClient
import ai.govbiz.core._health_ai_service.service.dto.AiServiceHealthResult
import org.springframework.stereotype.Service

@Service
class AiServiceHealthService(
    private val aiServiceHealthClient: AiServiceHealthClient,
) {
    fun getHealth(): AiServiceHealthResult {
        val payload = aiServiceHealthClient.getHealth()

        val status = payload.status
        val service = payload.service
        if (status != EXPECTED_STATUS || service != EXPECTED_SERVICE) {
            throw AiServiceCallException.invalidResponse(
                "AI Service health response violated the expected contract",
                null,
            )
        }

        return AiServiceHealthResult(status, service)
    }

    private companion object {
        const val EXPECTED_STATUS = "up"
        const val EXPECTED_SERVICE = "govbiz-ai-service"
    }
}
