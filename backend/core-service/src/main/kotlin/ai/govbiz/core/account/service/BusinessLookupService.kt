package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.bizno.BiznoClient
import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness
import ai.govbiz.core.account.service.exception.BusinessNotFoundException
import org.springframework.stereotype.Service

/**
 * 회원이 입력한 사업자등록번호를 국세청 조회(Bizno)로 확인합니다. 기업 등록은 다음 단계에서 이 조회를 다시 씁니다.
 * 상호와 사업자 상태만 돌려주고 소재지·업종처럼 국세청이 주지 않는 값은 담당자 입력으로 남깁니다.
 */
@Service
class BusinessLookupService(
    private val biznoClient: BiznoClient,
) {

    /** 등록되지 않은 번호는 404, 휴·폐업은 상태와 함께 그대로 돌려줍니다. */
    fun lookup(businessNumber: String): BiznoBusiness =
        biznoClient.findByBusinessNumber(normalizeBusinessNumber(businessNumber)).firstOrNull()
            ?: throw BusinessNotFoundException()

    companion object {
        const val BUSINESS_NUMBER_LENGTH = 10

        /** 공개 API·저장소가 같은 표기를 쓰도록 사업자등록번호에서 숫자만 남깁니다. */
        fun normalizeBusinessNumber(businessNumber: String): String {
            val digits = businessNumber.filter(Char::isDigit)
            require(digits.length == BUSINESS_NUMBER_LENGTH) { "businessNumber must be 10 digits" }
            return digits
        }
    }
}
