package ai.govbiz.core.applicationpreparation.client.ai.exception

/** AI Service가 문서의 native 입력 대상 수가 계약 한도를 넘어 분석할 수 없다고 명시적으로 확정한 경우입니다. */
class AiApplicationFormTooLargeException : RuntimeException("Application form native target limit exceeded")
