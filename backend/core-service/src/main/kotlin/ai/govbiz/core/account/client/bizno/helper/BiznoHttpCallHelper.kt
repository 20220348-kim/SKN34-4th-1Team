package ai.govbiz.core.account.client.bizno.helper

import ai.govbiz.core._common.helper.executeHttpCall
import ai.govbiz.core.account.client.bizno.exception.BiznoClientException
import tools.jackson.core.JacksonException

/**
 * 공통 HTTP 분류를 Bizno 오류 계약에 맞게 변환합니다.
 *
 * Spring의 통신 예외 메시지에는 API 키가 담긴 요청 URL이 포함되므로, 원인으로는 그 안의
 * 하위 I/O 예외만 보존해 로그에 키가 남지 않게 합니다.
 */
internal fun <T> executeBiznoHttpCall(block: () -> T): T =
    try {
        executeHttpCall(
            onTimeout = { exception -> BiznoClientException.timeout(exception.cause ?: exception) },
            onUnavailable = { exception -> BiznoClientException.unavailable(exception.cause ?: exception) },
            onUpstreamError = { exception ->
                BiznoClientException.upstreamError(
                    "Bizno API returned HTTP ${exception.statusCode.value()}",
                    null,
                )
            },
            onInvalidResponse = { exception ->
                BiznoClientException.invalidResponse(
                    "Bizno API response could not be decoded",
                    exception.cause,
                )
            },
            block = block,
        )
    } catch (exception: JacksonException) {
        throw BiznoClientException.invalidResponse(
            "Bizno API response could not be decoded",
            exception,
        )
    }
