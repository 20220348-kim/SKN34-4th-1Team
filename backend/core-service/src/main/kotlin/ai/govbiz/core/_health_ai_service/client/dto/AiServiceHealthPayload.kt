package ai.govbiz.core._health_ai_service.client.dto

/** AI Service 내부 상태 확인 응답의 역직렬화 모델입니다. */
data class AiServiceHealthPayload(
    val status: String?,
    val service: String?,
)
