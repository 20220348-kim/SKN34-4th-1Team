package ai.govbiz.core.supportprogram.client.cntradenotice.exception

/** 외부 응답·요청 URL에는 인증키가 포함될 수 있어 원인 예외나 응답 본문을 보존하지 않습니다. */
class CnTradeNoticeClientException private constructor(val failure: Failure, message: String) : RuntimeException(message) {
    enum class Failure { NOT_CONFIGURED, UPSTREAM_ERROR, INVALID_RESPONSE, UNAVAILABLE, TIMEOUT }

    companion object {
        fun notConfigured() = CnTradeNoticeClientException(Failure.NOT_CONFIGURED, "충청남도 온라인수출지원시스템 API key is not configured")
        fun upstreamError(status: Int) = CnTradeNoticeClientException(Failure.UPSTREAM_ERROR, "충청남도 온라인수출지원시스템 API returned HTTP $status")
        fun invalidResponse(message: String) = CnTradeNoticeClientException(Failure.INVALID_RESPONSE, message)
        fun unavailable() = CnTradeNoticeClientException(Failure.UNAVAILABLE, "충청남도 온라인수출지원시스템 API could not be reached")
        fun timeout() = CnTradeNoticeClientException(Failure.TIMEOUT, "충청남도 온라인수출지원시스템 API request timed out")
    }
}
