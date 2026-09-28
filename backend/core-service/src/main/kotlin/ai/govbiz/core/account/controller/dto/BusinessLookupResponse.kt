package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness

/** 등록 전 미리보기입니다. 국세청이 알려 주는 상호·상태만 담고 소재지·업종은 없습니다. */
data class BusinessLookupResponse(
    val businessNumber: String,
    val companyName: String,
    val businessStatus: String,
    /** 국세청 상태 코드. `01` 계속사업자 · `02` 휴업자 · `03` 폐업자 */
    val businessStatusCode: String,
    /** 계속사업자만 참. 파트너 모집글·제안은 이 값이 참일 때만 쓸 수 있습니다. */
    val isActive: Boolean,
    /** 계속·휴업자는 참, 폐업자는 거짓. 기업 등록은 이 값이 참일 때만 허용합니다. */
    val canRegister: Boolean,
) {
    companion object {
        fun from(business: BiznoBusiness): BusinessLookupResponse =
            BusinessLookupResponse(
                businessNumber = business.businessNumber,
                companyName = business.companyName,
                businessStatus = business.businessStatus,
                businessStatusCode = business.businessStatusCode,
                isActive = business.isActive,
                canRegister = business.canRegister,
            )
    }
}
