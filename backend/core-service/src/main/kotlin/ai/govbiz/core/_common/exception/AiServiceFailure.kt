package ai.govbiz.core._common.exception

/** AI Service 호출 실패를 공개 HTTP 오류로 변환할 때 사용하는 공통 분류입니다. */
enum class AiServiceFailure {
    UPSTREAM_ERROR,
    INVALID_RESPONSE,
    UNAVAILABLE,
    TIMEOUT,
}
