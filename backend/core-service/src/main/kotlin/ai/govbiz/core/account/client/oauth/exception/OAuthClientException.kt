package ai.govbiz.core.account.client.oauth.exception

import ai.govbiz.core.account.domain.OAuthProvider

/** 소셜 로그인 공급자 호출 실패입니다. 인가 코드·토큰·시크릿은 메시지와 원인에 남기지 않습니다. */
class OAuthClientException private constructor(
    val failure: Failure,
    message: String,
    cause: Throwable?,
) : RuntimeException(message, cause) {

    enum class Failure {
        NOT_CONFIGURED,
        REJECTED,
        INVALID_RESPONSE,
        UNAVAILABLE,
        TIMEOUT,
    }

    companion object {
        fun notConfigured(provider: OAuthProvider): OAuthClientException =
            OAuthClientException(Failure.NOT_CONFIGURED, "$provider OAuth client is not configured", null)

        /** 인가 코드 재사용·만료처럼 공급자가 4xx·5xx로 거절한 경우입니다. 오류 본문은 남기지 않습니다. */
        fun rejected(provider: OAuthProvider, status: Int): OAuthClientException =
            OAuthClientException(Failure.REJECTED, "$provider OAuth endpoint returned HTTP $status", null)

        fun invalidResponse(provider: OAuthProvider, message: String, cause: Throwable? = null): OAuthClientException =
            OAuthClientException(Failure.INVALID_RESPONSE, "$provider OAuth response is invalid: $message", cause)

        fun unavailable(provider: OAuthProvider, cause: Throwable?): OAuthClientException =
            OAuthClientException(Failure.UNAVAILABLE, "$provider OAuth endpoint could not be reached", cause)

        fun timeout(provider: OAuthProvider, cause: Throwable?): OAuthClientException =
            OAuthClientException(Failure.TIMEOUT, "$provider OAuth request timed out", cause)
    }
}
