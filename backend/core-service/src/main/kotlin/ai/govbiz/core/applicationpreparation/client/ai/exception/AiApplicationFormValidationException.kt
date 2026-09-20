package ai.govbiz.core.applicationpreparation.client.ai.exception

/** AI Service가 응답을 받은 뒤 원문 근거 검증 실패를 명시적으로 확정한 경우입니다. */
class AiApplicationFormValidationException : RuntimeException("Application form evidence validation failed")
