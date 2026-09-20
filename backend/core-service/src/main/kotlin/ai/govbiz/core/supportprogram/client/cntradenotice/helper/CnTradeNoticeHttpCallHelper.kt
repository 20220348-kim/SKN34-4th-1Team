package ai.govbiz.core.supportprogram.client.cntradenotice.helper

import ai.govbiz.core._common.helper.executeHttpCall
import ai.govbiz.core.supportprogram.client.cntradenotice.exception.CnTradeNoticeClientException
import tools.jackson.core.JacksonException

/** 실패 유형만 보존하고 서비스키가 들어갈 수 있는 원인 메시지는 외부 경계에서 버립니다. */
internal fun <T> executeCnTradeNoticeHttpCall(block: () -> T): T =
    try {
        executeHttpCall(
            onTimeout = { CnTradeNoticeClientException.timeout() },
            onUnavailable = { CnTradeNoticeClientException.unavailable() },
            onUpstreamError = { CnTradeNoticeClientException.upstreamError(it.statusCode.value()) },
            onInvalidResponse = { CnTradeNoticeClientException.invalidResponse("충청남도 온라인수출지원시스템 API response could not be decoded") },
            block = block,
        )
    } catch (_: JacksonException) {
        throw CnTradeNoticeClientException.invalidResponse("충청남도 온라인수출지원시스템 API response could not be decoded")
    } catch (_: IllegalArgumentException) {
        throw CnTradeNoticeClientException.invalidResponse("충청남도 온라인수출지원시스템 API response could not be decoded")
    }
