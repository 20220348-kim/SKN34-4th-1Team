package ai.govbiz.core._common.exception

/** AI Service 호출 실패를 Core API의 공통 오류 분류로 표현합니다. */
class AiServiceCallException private constructor(
    val failure: AiServiceFailure,
    message: String,
    cause: Throwable?,
) : RuntimeException(message, cause) {
    companion object {
        fun upstreamError(message: String, cause: Throwable?): AiServiceCallException =
            AiServiceCallException(AiServiceFailure.UPSTREAM_ERROR, message, cause)

        fun invalidResponse(message: String, cause: Throwable?): AiServiceCallException =
            AiServiceCallException(AiServiceFailure.INVALID_RESPONSE, message, cause)

        fun unavailable(cause: Throwable?): AiServiceCallException =
            AiServiceCallException(
                AiServiceFailure.UNAVAILABLE,
                "AI Service could not be reached",
                cause,
            )

        fun timeout(cause: Throwable?): AiServiceCallException =
            AiServiceCallException(
                AiServiceFailure.TIMEOUT,
                "AI Service request timed out",
                cause,
            )
    }
}
