package ai.govbiz.core.account.client.bizno

import ai.govbiz.core.account.client.bizno.config.BiznoClientProperties
import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness
import ai.govbiz.core.account.client.bizno.exception.BiznoClientException
import ai.govbiz.core.account.client.bizno.helper.executeBiznoHttpCall
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.databind.JsonNode

/**
 * Bizno 사업자등록번호 조회 API를 호출해 국세청에 등록된 기업만 돌려줍니다.
 *
 * 실제 응답은 `items`가 10칸 배열이고 빈 칸은 `null`이며, 결과가 없으면 `items` 키 자체가 없습니다.
 * 미등록 번호도 임의 상호가 담긴 항목이 돌아오므로 사업자 상태 코드(`bsttcd`)가 있는 항목만 인정합니다.
 * Bizno는 상호·사업자 상태 정도만 쓸 수 있고 소재지·업종·설립일은 주지 않습니다.
 */
@Component
class BiznoClient(
    @param:Qualifier("biznoRestClient") private val restClient: RestClient,
    private val properties: BiznoClientProperties,
) {

    /** 하이픈 없는 숫자 10자리 사업자등록번호로 조회합니다. */
    fun findByBusinessNumber(businessNumber: String): List<BiznoBusiness> {
        require(businessNumber.length == BUSINESS_NUMBER_LENGTH && businessNumber.all(Char::isDigit)) {
            "business number must be 10 digits"
        }
        val apiKey = properties.apiKey
        if (apiKey.isBlank()) {
            throw BiznoClientException.notConfigured()
        }

        val body = executeBiznoHttpCall {
            val response = restClient.get()
                .uri(
                    properties.endpointUrl.rawPath +
                        "?key={key}" +
                        "&gb=$LOOKUP_BY_BUSINESS_NUMBER" +
                        "&q={query}" +
                        "&type=json",
                    apiKey,
                    businessNumber,
                )
                .retrieve()
                .onStatus(
                    { statusCode -> statusCode.value() != HttpStatus.OK.value() },
                    { _, clientResponse ->
                        throw BiznoClientException.upstreamError(
                            "Bizno API returned unexpected HTTP ${clientResponse.statusCode.value()}",
                            null,
                        )
                    },
                )
                .toEntity(JsonNode::class.java)

            response.body
                ?: throw BiznoClientException.invalidResponse(
                    "Bizno API returned an empty response",
                    null,
                )
        }

        return decode(body, businessNumber)
    }

    private fun decode(body: JsonNode, businessNumber: String): List<BiznoBusiness> {
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
        if (items.isMissingNode || items.isNull) {
            return emptyList()
        }
        if (!items.isArray) {
            throw BiznoClientException.invalidResponse("Bizno API items were not an array", null)
        }

        val businesses = ArrayList<BiznoBusiness>()
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
                BiznoBusiness(
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

    private companion object {
        const val BUSINESS_NUMBER_LENGTH = 10
        const val LOOKUP_BY_BUSINESS_NUMBER = 1
        const val RESULT_CODE_SUCCESS = 0
    }
}
