package ai.govbiz.core.supportprogram.client.kstartup.exception

/** K-Startup 공식 상세 페이지 원문 조회 실패를 Client 경계에서 표현합니다. */
class KStartupSourceDocumentClientException private constructor(
    val failure: Failure,
    message: String,
    cause: Throwable?,
) : RuntimeException(message, cause) {
    enum class Failure {
        UPSTREAM_ERROR,
        INVALID_RESPONSE,
        UNAVAILABLE,
        TIMEOUT,
    }

    companion object {
        fun upstreamError(message: String, cause: Throwable?): KStartupSourceDocumentClientException =
            KStartupSourceDocumentClientException(Failure.UPSTREAM_ERROR, message, cause)

        fun invalidResponse(message: String, cause: Throwable?): KStartupSourceDocumentClientException =
            KStartupSourceDocumentClientException(Failure.INVALID_RESPONSE, message, cause)

        fun unavailable(cause: Throwable?): KStartupSourceDocumentClientException =
            KStartupSourceDocumentClientException(
                Failure.UNAVAILABLE,
                "K-Startup source document could not be reached",
                cause,
            )

        fun timeout(cause: Throwable?): KStartupSourceDocumentClientException =
            KStartupSourceDocumentClientException(
                Failure.TIMEOUT,
                "K-Startup source document request timed out",
                cause,
            )
    }
}
