package ai.govbiz.core.account.client.bizno

import ai.govbiz.core.account.client.bizno.config.BiznoClientProperties
import ai.govbiz.core.account.client.bizno.mapper.BiznoBusinessMapper
import ai.govbiz.core.account.domain.RegisteredBusiness
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
    fun findByBusinessNumber(businessNumber: String): List<RegisteredBusiness> {
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

        return BiznoBusinessMapper.toDomain(body, businessNumber)
    }

    private companion object {
        const val BUSINESS_NUMBER_LENGTH = 10
        const val LOOKUP_BY_BUSINESS_NUMBER = 1
    }
}
