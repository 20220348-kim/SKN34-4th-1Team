package ai.govbiz.core._common.helper

import ai.govbiz.core._common.exception.AiServiceCallException
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.http.HttpTimeoutException
import java.util.concurrent.TimeoutException
import org.springframework.web.client.ResourceAccessException
import org.springframework.web.client.RestClientException
import org.springframework.web.client.RestClientResponseException

/** 외부 HTTP Client가 공유하는 Spring 통신 예외 분류를 실행합니다. */
internal fun <T> executeHttpCall(
    onTimeout: (Throwable) -> RuntimeException,
    onUnavailable: (Throwable) -> RuntimeException,
    onUpstreamError: (RestClientResponseException) -> RuntimeException,
    onInvalidResponse: (RestClientException) -> RuntimeException,
    block: () -> T,
): T =
    try {
        block()
    } catch (exception: IOException) {
        if (exception.hasTimeoutCause()) {
            throw onTimeout(exception)
        }
        throw onUnavailable(exception)
    } catch (exception: ResourceAccessException) {
        if (exception.hasTimeoutCause()) {
            throw onTimeout(exception)
        }
        throw onUnavailable(exception)
    } catch (exception: RestClientResponseException) {
        throw onUpstreamError(exception)
    } catch (exception: RestClientException) {
        throw onInvalidResponse(exception)
    }

/** 공통 HTTP 분류를 AI Service 공개 오류 계약에 맞게 변환합니다. */
fun <T> executeAiServiceCall(block: () -> T): T =
    executeHttpCall(
        onTimeout = { exception -> AiServiceCallException.timeout(exception) },
        onUnavailable = { exception -> AiServiceCallException.unavailable(exception) },
        onUpstreamError = { exception ->
            AiServiceCallException.upstreamError(
                "AI Service returned HTTP ${exception.statusCode.value()}",
                exception,
            )
        },
        onInvalidResponse = { exception ->
            AiServiceCallException.invalidResponse(
                "AI Service response could not be decoded",
                exception,
            )
        },
        block = block,
    )

private fun Throwable.hasTimeoutCause(): Boolean {
    var current: Throwable? = this
    while (current != null) {
        if (
            current is HttpTimeoutException ||
            current is SocketTimeoutException ||
            current is TimeoutException
        ) {
            return true
        }
        current = current.cause
    }
    return false
}
