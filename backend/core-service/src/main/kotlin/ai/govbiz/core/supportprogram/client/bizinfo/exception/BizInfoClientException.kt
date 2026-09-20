package ai.govbiz.core.supportprogram.client.bizinfo.exception

class BizInfoClientException private constructor(
    val failure: Failure,
    message: String,
    cause: Throwable?,
) : RuntimeException(message, cause) {

    enum class Failure {
        NOT_CONFIGURED,
        UPSTREAM_ERROR,
        INVALID_RESPONSE,
        UNAVAILABLE,
        TIMEOUT,
    }

    companion object {
        fun notConfigured(): BizInfoClientException =
            BizInfoClientException(
                Failure.NOT_CONFIGURED,
                "BizInfo service key is not configured",
                null,
            )

        fun upstreamError(message: String, cause: Throwable?): BizInfoClientException =
            BizInfoClientException(Failure.UPSTREAM_ERROR, message, cause)

        fun invalidResponse(message: String, cause: Throwable?): BizInfoClientException =
            BizInfoClientException(Failure.INVALID_RESPONSE, message, cause)

        fun unavailable(cause: Throwable?): BizInfoClientException =
            BizInfoClientException(
                Failure.UNAVAILABLE,
                "BizInfo API could not be reached",
                cause,
            )

        fun timeout(cause: Throwable?): BizInfoClientException =
            BizInfoClientException(
                Failure.TIMEOUT,
                "BizInfo API request timed out",
                cause,
            )
    }
}
