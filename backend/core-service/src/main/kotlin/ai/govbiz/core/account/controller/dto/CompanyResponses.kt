package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.Company
import ai.govbiz.core.account.domain.CompanySummary
import java.time.format.DateTimeFormatter

data class CompanyResponse(
    val businessNumber: String,
    val companyName: String,
    val businessStatus: String,
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
) {
    companion object {
        fun from(summary: CompanySummary): CompanySummaryResponse =
            CompanySummaryResponse(companyName = summary.companyName, businessNumber = summary.businessNumber)
    }
}
