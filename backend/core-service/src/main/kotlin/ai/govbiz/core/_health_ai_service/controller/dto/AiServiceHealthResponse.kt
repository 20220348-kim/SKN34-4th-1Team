package ai.govbiz.core._health_ai_service.controller.dto

/** Core API가 소유하는 브라우저 공개 AI Service Health 응답입니다. */
data class AiServiceHealthResponse(
    val status: String,
    val service: String,
)
