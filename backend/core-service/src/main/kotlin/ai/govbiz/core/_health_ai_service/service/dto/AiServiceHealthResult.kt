package ai.govbiz.core._health_ai_service.service.dto

/** 검증을 통과한 AI Service 상태를 Presentation Layer에 전달하는 애플리케이션 결과입니다. */
data class AiServiceHealthResult(
    val status: String,
    val service: String,
)
