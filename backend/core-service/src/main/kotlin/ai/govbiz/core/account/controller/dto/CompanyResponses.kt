package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.Company
import ai.govbiz.core.account.domain.CompanySummary
import java.time.format.DateTimeFormatter

data class CompanyResponse(
    val businessNumber: String,
    val companyName: String,
    val businessStatus: String,
    /** 국세청 상태 코드. `01` 계속사업자 · `02` 휴업자 */
    val businessStatusCode: String,
    val region: String,
    val industry: String,
    val foundedYear: Int,
    val homepageUrl: String?,
    val businessVerifiedAt: String,
    val updatedAt: String,
) {
    companion object {
        private val FORMATTER: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE_TIME

        fun from(company: Company): CompanyResponse =
            CompanyResponse(
                businessNumber = company.businessNumber,
                companyName = company.companyName,
                businessStatus = company.businessStatus,
                businessStatusCode = company.businessStatusCode,
                region = company.profile.region,
                industry = company.profile.industry,
                foundedYear = company.profile.foundedYear,
                homepageUrl = company.profile.homepageUrl,
                businessVerifiedAt = company.businessVerifiedAt.format(FORMATTER),
                updatedAt = company.updatedAt.format(FORMATTER),
            )
    }
}

/** 세션·내 계정 응답에 실리는 기업 요약입니다. */
data class CompanySummaryResponse(
    val companyName: String,
    val businessNumber: String,
    /** 국세청 상태 코드. `01` 계속사업자 · `02` 휴업자. 화면은 이 값으로 파트너 메뉴 잠금 이유를 고릅니다. */
    val businessStatusCode: String,
) {
    companion object {
        fun from(summary: CompanySummary): CompanySummaryResponse =
            CompanySummaryResponse(
                companyName = summary.companyName,
                businessNumber = summary.businessNumber,
                businessStatusCode = summary.businessStatusCode,
            )
    }
}
