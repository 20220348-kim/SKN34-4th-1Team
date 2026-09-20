package ai.govbiz.core.account.client.oauth.helper

import ai.govbiz.core._common.helper.executeHttpCall
import ai.govbiz.core.account.client.oauth.exception.OAuthClientException
import ai.govbiz.core.account.domain.OAuthProvider
import tools.jackson.core.JacksonException

/**
 * 공통 HTTP 분류를 소셜 로그인 오류로 바꿉니다. 요청 본문(인가 코드·시크릿)과 인증 헤더는 예외 메시지에 들어가지 않고,
 * 공급자의 오류 본문도 남기지 않습니다.
 */
internal fun <T> executeOAuthHttpCall(provider: OAuthProvider, block: () -> T): T =
    try {
        executeHttpCall(
            onTimeout = { exception -> OAuthClientException.timeout(provider, exception.cause ?: exception) },
            onUnavailable = { exception -> OAuthClientException.unavailable(provider, exception.cause ?: exception) },
            onUpstreamError = { exception -> OAuthClientException.rejected(provider, exception.statusCode.value()) },
            onInvalidResponse = { exception ->
                OAuthClientException.invalidResponse(provider, "response could not be decoded", exception.cause)
            },
            block = block,
        )
    } catch (exception: JacksonException) {
        throw OAuthClientException.invalidResponse(provider, "response could not be decoded", exception)
    }
