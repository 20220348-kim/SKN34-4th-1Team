package ai.govbiz.core.supportprogram.client.bizinfo.helper

import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoClientException
import ai.govbiz.core.supportprogram.client.bizinfo.dto.BizInfoPage
import ai.govbiz.core.supportprogram.client.bizinfo.dto.BizInfoProgramPayload
import tools.jackson.databind.JsonNode

/** 기업마당 JSON의 허용된 페이지 구조만 내부 전송 모델로 변환합니다. */
internal object BizInfoPageDecoderHelper {

    fun decode(
        root: JsonNode,
        maxItems: Int,
    ): BizInfoPage {
        val response = root.path("response")
        val header = response.path("header")
        val resultCode = requiredText(header, "resultCode")
        if (resultCode != "00") {
            throw BizInfoClientException.upstreamError(
                "BizInfo API returned a non-success result code",
                null,
            )
        }

        val body = response.path("body")
        val totalCount = integer(body, "totalCount")
        if (body.isMissingNode || totalCount == null) {
            throw invalidResponse("BizInfo API response did not contain a valid body")
        }
        if (totalCount < 0) {
            throw invalidResponse("BizInfo API returned a negative totalCount")
        }
        val pageNumber = positiveInteger(body, "pageNo")
            ?: throw invalidResponse("BizInfo API response did not contain a valid pageNo")
        val pageSize = positiveInteger(body, "numOfRows")
            ?: throw invalidResponse("BizInfo API response did not contain a valid numOfRows")
        if (pageSize > maxItems) {
            throw invalidResponse("BizInfo API page exceeded the safe item limit")
        }

        return BizInfoPage(
            items = readItems(body.path("items"), totalCount, pageSize),
            totalCount = totalCount,
            pageNumber = pageNumber,
            pageSize = pageSize,
        )
    }

    private fun readItems(
        itemsNode: JsonNode,
        totalCount: Int,
        maxItems: Int,
    ): List<BizInfoProgramPayload> {
        if (itemsNode.isMissingNode || itemsNode.isNull) {
            return emptyItemsOrThrow(totalCount)
        }

        val itemNode = when {
            itemsNode.isArray -> itemsNode
            itemsNode.isObject -> itemsNode.path("item")
            else -> throw invalidResponse("BizInfo API items had an unexpected shape")
        }
        if (itemNode.isMissingNode || itemNode.isNull) {
            return emptyItemsOrThrow(totalCount)
        }

        val items: List<BizInfoProgramPayload> = when {
            itemNode.isArray -> decodeArray(itemNode, maxItems)
            itemNode.isObject -> listOf(toPayload(itemNode))
            else -> throw invalidResponse("BizInfo API items had an unexpected shape")
        }
        if (items.isEmpty() && totalCount > 0) {
            throw invalidResponse("BizInfo API omitted items for a non-empty result")
        }
        if (items.size > totalCount) {
            throw invalidResponse("BizInfo API returned more items than totalCount")
        }
        return items.toList()
    }

    private fun decodeArray(
        itemNode: JsonNode,
        maxItems: Int,
    ): List<BizInfoProgramPayload> {
        val items = ArrayList<BizInfoProgramPayload>()
        for (node in itemNode) {
            if (items.size >= maxItems) {
                throw invalidResponse("BizInfo API page exceeded the safe item limit")
            }
            items += toPayload(node)
        }
        return items
    }

    private fun emptyItemsOrThrow(totalCount: Int): List<BizInfoProgramPayload> =
        if (totalCount == 0) emptyList()
        else throw invalidResponse("BizInfo API omitted items for a non-empty result")

    private fun toPayload(node: JsonNode): BizInfoProgramPayload {
        if (!node.isObject) {
            throw invalidResponse("BizInfo API item was not an object")
        }
        return BizInfoProgramPayload(
            title = text(node, "pblancNm"),
            sourceUrl = text(node, "pblancUrl"),
            id = text(node, "pblancId"),
            jurisdictionOrganization = text(node, "jrsdInsttNm"),
            executingOrganization = text(node, "excInsttNm"),
            summaryHtml = text(node, "bsnsSumryCn"),
            category = text(node, "pldirSportRealmLclasCodeNm"),
            createdAt = text(node, "creatPnttm"),
            applicationPeriod = text(node, "reqstBeginEndDe"),
            updatedAt = text(node, "updtPnttm"),
            target = text(node, "trgetNm"),
            hashtags = text(node, "hashtags"),
        )
    }

    private fun requiredText(node: JsonNode, fieldName: String): String =
        text(node, fieldName)
            ?: throw invalidResponse("BizInfo API response did not contain $fieldName")

    private fun text(node: JsonNode, fieldName: String): String? {
        val value = node.path(fieldName)
        if (value.isMissingNode || value.isNull) return null
        if (!value.isString) {
            throw invalidResponse("BizInfo API field $fieldName was not a string")
        }
        return value.asString().trim().ifEmpty { null }
    }

    private fun integer(node: JsonNode, fieldName: String): Int? {
        val value = node.path(fieldName)
        if (!value.isIntegralNumber || !value.canConvertToInt()) return null
        return value.intValue()
    }

    private fun positiveInteger(node: JsonNode, fieldName: String): Int? =
        integer(node, fieldName)?.takeIf { it > 0 }

    private fun invalidResponse(message: String): BizInfoClientException =
        BizInfoClientException.invalidResponse(message, null)
}
