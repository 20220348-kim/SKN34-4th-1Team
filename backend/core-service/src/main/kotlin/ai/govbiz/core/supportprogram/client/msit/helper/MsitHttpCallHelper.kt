package ai.govbiz.core.supportprogram.client.msit.helper

import ai.govbiz.core._common.helper.executeHttpCall
import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
import tools.jackson.core.JacksonException

internal fun <T> executeMsitHttpCall(block: () -> T): T =
    try {
        executeHttpCall(
            onTimeout = { MsitClientException.timeout() },
            onUnavailable = { MsitClientException.unavailable() },
            onUpstreamError = { MsitClientException.upstreamError(it.statusCode.value()) },
            onInvalidResponse = { MsitClientException.invalidResponse("MSIT API response could not be decoded") },
            block = block,
        )
    } catch (_: JacksonException) {
        throw MsitClientException.invalidResponse("MSIT API response could not be decoded")
    } catch (_: IllegalArgumentException) {
        throw MsitClientException.invalidResponse("MSIT API response could not be decoded")
    }
