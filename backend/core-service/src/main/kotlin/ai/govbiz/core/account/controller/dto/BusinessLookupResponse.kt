package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness

/** 등록 전 미리보기입니다. 국세청이 알려 주는 상호·상태만 담고 소재지·업종은 없습니다. */
data class BusinessLookupResponse(
    val businessNumber: String,
    val companyName: String,
    val businessStatus: String,
    val isActive: Boolean,
) {
    companion object {
        fun from(business: BiznoBusiness): BusinessLookupResponse =
            BusinessLookupResponse(
                businessNumber = business.businessNumber,
                companyName = business.companyName,
                businessStatus = business.businessStatus,
                isActive = business.isActive,
            )
    }
}
