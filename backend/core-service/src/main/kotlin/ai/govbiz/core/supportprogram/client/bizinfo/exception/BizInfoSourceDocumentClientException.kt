package ai.govbiz.core.supportprogram.client.bizinfo.exception

/** 기업마당 공식 상세 페이지 원문 조회 실패를 Client 경계에서 표현합니다. */
class BizInfoSourceDocumentClientException private constructor(
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
        fun upstreamError(message: String, cause: Throwable?): BizInfoSourceDocumentClientException =
            BizInfoSourceDocumentClientException(Failure.UPSTREAM_ERROR, message, cause)

        fun invalidResponse(message: String, cause: Throwable?): BizInfoSourceDocumentClientException =
            BizInfoSourceDocumentClientException(Failure.INVALID_RESPONSE, message, cause)

        fun unavailable(cause: Throwable?): BizInfoSourceDocumentClientException =
            BizInfoSourceDocumentClientException(
                Failure.UNAVAILABLE,
                "BizInfo source document could not be reached",
                cause,
            )

        fun timeout(cause: Throwable?): BizInfoSourceDocumentClientException =
            BizInfoSourceDocumentClientException(
                Failure.TIMEOUT,
                "BizInfo source document request timed out",
                cause,
            )
    }
}
