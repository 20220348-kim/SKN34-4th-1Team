package ai.govbiz.core.supportprogram.client.kstartup.helper

import ai.govbiz.core._common.helper.executeHttpCall
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupClientException
import tools.jackson.core.JacksonException

/** 실패 유형만 보존하고 서비스키가 들어갈 수 있는 원인 메시지는 외부 경계에서 버립니다. */
internal fun <T> executeKStartupHttpCall(block: () -> T): T =
    try {
        executeHttpCall(
            onTimeout = { KStartupClientException.timeout() },
            onUnavailable = { KStartupClientException.unavailable() },
            onUpstreamError = { KStartupClientException.upstreamError(it.statusCode.value()) },
            onInvalidResponse = { KStartupClientException.invalidResponse("K-Startup API response could not be decoded") },
            block = block,
        )
    } catch (_: JacksonException) {
        throw KStartupClientException.invalidResponse("K-Startup API response could not be decoded")
    } catch (_: IllegalArgumentException) {
        throw KStartupClientException.invalidResponse("K-Startup API response could not be decoded")
    }
