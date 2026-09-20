package ai.govbiz.core.supportprogram.client.msit.exception

/** 인증키가 포함될 수 있는 요청 URL·본문·원인 예외를 외부로 전파하지 않습니다. */
class MsitClientException private constructor(val failure: Failure, message: String) : RuntimeException(message) {
    enum class Failure { NOT_CONFIGURED, UPSTREAM_ERROR, INVALID_RESPONSE, UNAVAILABLE, TIMEOUT }

    companion object {
        fun notConfigured() = MsitClientException(Failure.NOT_CONFIGURED, "MSIT API key is not configured")
        fun upstreamError(status: Int) = MsitClientException(Failure.UPSTREAM_ERROR, "MSIT API returned HTTP $status")
        fun invalidResponse(message: String) = MsitClientException(Failure.INVALID_RESPONSE, message)
        fun unavailable() = MsitClientException(Failure.UNAVAILABLE, "MSIT API could not be reached")
        fun timeout() = MsitClientException(Failure.TIMEOUT, "MSIT API request timed out")
    }
}
