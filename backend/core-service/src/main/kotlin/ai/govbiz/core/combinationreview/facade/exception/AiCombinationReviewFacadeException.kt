package ai.govbiz.core.combinationreview.facade.exception

/** AI 호출·계약 검증을 감춘 경계의 실패. Service는 외부 DTO나 Client 예외를 해석하지 않는다. */
class AiCombinationReviewFacadeException(val reason: Reason, cause: Throwable? = null) : RuntimeException(null, cause) {
    enum class Reason { UNAVAILABLE, INVALID_RESPONSE, CONTEXT_TOO_LARGE }
}
