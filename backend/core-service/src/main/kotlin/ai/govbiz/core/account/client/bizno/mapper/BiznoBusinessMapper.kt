package ai.govbiz.core.account.client.bizno.mapper

import ai.govbiz.core.account.client.bizno.exception.BiznoClientException
import ai.govbiz.core.account.domain.RegisteredBusiness
import tools.jackson.databind.JsonNode

/** Bizno 원문 JSON을 검증하고 조회한 번호에 해당하는 등록 사업자 내부 모델로 변환한다. */
object BiznoBusinessMapper {
    fun toDomain(body: JsonNode, businessNumber: String): List<RegisteredBusiness> {
        if (!body.isObject) {
            throw BiznoClientException.invalidResponse("Bizno API response was not a JSON object", null)
        }
        val resultCode = body.path("resultCode")
        if (!resultCode.isNumber) {
            throw BiznoClientException.invalidResponse("Bizno API response has no resultCode", null)
        }
        if (resultCode.asInt() != RESULT_CODE_SUCCESS) {
            throw BiznoClientException.upstreamError(
                "Bizno API returned result code ${resultCode.asInt()}",
                null,
            )
        }

        val items = body.path("items")
        if (items.isMissingNode || items.isNull) return emptyList()
        if (!items.isArray) {
            throw BiznoClientException.invalidResponse("Bizno API items were not an array", null)
        }

        val businesses = ArrayList<RegisteredBusiness>()
        for (item in items) {
            if (item.isNull) continue
            if (!item.isObject) {
                throw BiznoClientException.invalidResponse("Bizno API item was not a JSON object", null)
            }
            val number = item.text("bno").filter(Char::isDigit)
            val companyName = item.text("company")
            if (number.length != BUSINESS_NUMBER_LENGTH || companyName.isBlank()) {
                throw BiznoClientException.invalidResponse("Bizno API item is missing bno or company", null)
            }
            if (number != businessNumber) continue
            val statusCode = item.text("bsttcd")
            if (statusCode.isBlank()) continue

            businesses.add(
                RegisteredBusiness(
                    businessNumber = number,
                    companyName = companyName,
                    businessStatus = item.text("bstt"),
                    businessStatusCode = statusCode,
                ),
            )
        }
        return java.util.List.copyOf(businesses)
    }

    /** 문자열 필드가 없거나 null이면 빈 문자열로 읽습니다. */
    private fun JsonNode.text(fieldName: String): String {
        val value = path(fieldName)
        if (value.isMissingNode || value.isNull) return ""
        return value.asString().trim()
    }

    private const val BUSINESS_NUMBER_LENGTH = 10
    private const val RESULT_CODE_SUCCESS = 0
}
