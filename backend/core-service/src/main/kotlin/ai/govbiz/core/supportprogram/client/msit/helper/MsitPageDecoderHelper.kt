package ai.govbiz.core.supportprogram.client.msit.helper

import ai.govbiz.core.supportprogram.client.msit.dto.MsitPage
import ai.govbiz.core.supportprogram.client.msit.dto.MsitProgramPayload
import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
import tools.jackson.databind.JsonNode

internal object MsitPageDecoderHelper {
    fun decode(root: JsonNode): MsitPage {
        val response = root.path("response")
        if (!root.isObject || !response.isArray || response.size() != 2) invalid("MSIT API returned an invalid response envelope")
        val entries = response.toList()
        val headers = entries.filter { it.isObject && it.has("header") }
        val bodies = entries.filter { it.isObject && it.has("body") }
        if (headers.size != 1 || bodies.size != 1) invalid("MSIT API returned an ambiguous response envelope")
        val header = headers.single().path("header")
        val body = bodies.single().path("body")
        if (!header.isObject || text(header, "resultCode") != "00") invalid("MSIT API returned an unsuccessful result code")
        if (!body.isObject || !body.path("items").isArray) invalid("MSIT API returned an invalid page body")
        return MsitPage(
            totalCount = integer(body, "totalCount"), page = integer(body, "pageNo"), perPage = integer(body, "numOfRows"),
            items = body.path("items").toList().map { wrapper ->
                val item = wrapper.path("item")
                if (!wrapper.isObject || !item.isObject) invalid("MSIT API returned a non-object announcement")
                MsitProgramPayload(
                    title = text(item, "subject"), organization = text(item, "deptName"),
                    publishedAt = text(item, "pressDt"), sourceUrl = text(item, "viewUrl"),
                )
            },
        )
    }

    private fun integer(node: JsonNode, name: String): Int {
        val value = node.path(name)
        val integer = if (value.isIntegralNumber && value.canConvertToInt()) value.asInt()
            else if (value.isString && Regex("[0-9]+").matches(value.asString())) value.asString().toIntOrNull()
            else null
        return integer?.takeIf { it >= 0 } ?: invalid("MSIT API returned invalid $name metadata")
    }

    private fun text(node: JsonNode, name: String): String? {
        val value = node.path(name)
        if (value.isMissingNode || value.isNull) return null
        if (!value.isString) invalid("MSIT API returned an invalid $name field")
        return value.asString()
    }

    private fun invalid(message: String): Nothing = throw MsitClientException.invalidResponse(message)
}
