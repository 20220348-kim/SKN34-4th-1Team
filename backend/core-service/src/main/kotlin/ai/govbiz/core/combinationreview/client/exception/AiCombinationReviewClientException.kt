package ai.govbiz.core.combinationreview.client.exception

/** 중복 검토 AI HTTP 계약에서만 사용하는 실패. */
class AiCombinationReviewClientException(val reason: Reason) : RuntimeException() {
    enum class Reason { INVALID_RESPONSE, CONTEXT_TOO_LARGE }
}
