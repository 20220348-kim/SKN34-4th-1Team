package ai.govbiz.core.supportprogram.client.cntradenotice.helper

import ai.govbiz.core.supportprogram.client.cntradenotice.dto.CnTradeNoticePage
import ai.govbiz.core.supportprogram.client.cntradenotice.dto.CnTradeNoticeProgramPayload
import ai.govbiz.core.supportprogram.client.cntradenotice.exception.CnTradeNoticeClientException
import tools.jackson.databind.JsonNode

/** 공공데이터포털 15097093 첨부 명세의 최상위 JSON 계약만 허용합니다. */
internal object CnTradeNoticePageDecoderHelper {
    fun decode(body: JsonNode): CnTradeNoticePage {
        if (!body.isObject || text(body, "resultCode") != "09" || text(body, "resultMsg") != "RETURN_SUCCESS") {
            // HTTP 200인 OpenAPI_ServiceResponse 인증/게이트웨이 오류도 빈 정상 결과로 숨기지 않습니다.
            invalid("CNTRADE_NOTICE API returned an unsuccessful response")
        }
        val items = body.path("items")
        if (!items.isArray) invalid("CNTRADE_NOTICE API response has no items array")
        return CnTradeNoticePage(
            pageNo = integer(body, "pageNo"), numOfRows = integer(body, "numOfRows"),
            totalCount = integer(body, "totalCount"),
            items = items.toList().map { item ->
                if (!item.isObject) invalid("CNTRADE_NOTICE API returned a non-object notice")
                CnTradeNoticeProgramPayload(
                    id = text(item, "lbbNo", allowInteger = true), title = text(item, "title"),
                    organization = text(item, "orgNm"), contentHtml = text(item, "cont"),
                    registeredDate = text(item, "sregDtm"), modifiedDate = text(item, "smodifyDtm"),
                )
            },
        )
    }

    private fun integer(node: JsonNode, name: String): Int {
        val value = node.path(name)
        if (!value.isIntegralNumber || !value.canConvertToInt() || value.asInt() < 0) {
            invalid("CNTRADE_NOTICE API returned invalid $name metadata")
        }
        return value.asInt()
    }

    private fun text(node: JsonNode, name: String, allowInteger: Boolean = false): String? {
        val value = node.path(name)
        if (value.isMissingNode || value.isNull) return null
        if (!value.isString && !(allowInteger && value.isIntegralNumber)) invalid("CNTRADE_NOTICE API returned invalid $name")
        return value.asString()
    }

    private fun invalid(message: String): Nothing = throw CnTradeNoticeClientException.invalidResponse(message)
}
