package ai.govbiz.core.supportprogram.client.kstartup.exception

/** 외부 응답·요청 URL에는 인증키가 포함될 수 있어 원인 예외나 응답 본문을 보존하지 않습니다. */
class KStartupClientException private constructor(val failure: Failure, message: String) : RuntimeException(message) {
    enum class Failure { NOT_CONFIGURED, UPSTREAM_ERROR, INVALID_RESPONSE, UNAVAILABLE, TIMEOUT }

    companion object {
        fun notConfigured() = KStartupClientException(Failure.NOT_CONFIGURED, "K-Startup API key is not configured")
        fun upstreamError(status: Int) = KStartupClientException(Failure.UPSTREAM_ERROR, "K-Startup API returned HTTP $status")
        fun invalidResponse(message: String) = KStartupClientException(Failure.INVALID_RESPONSE, message)
        fun unavailable() = KStartupClientException(Failure.UNAVAILABLE, "K-Startup API could not be reached")
        fun timeout() = KStartupClientException(Failure.TIMEOUT, "K-Startup API request timed out")
    }
}
