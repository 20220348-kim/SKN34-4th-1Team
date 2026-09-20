package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.CompanyProfileInput
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

/** 담당자가 입력하는 프로필 항목입니다. 빈 홈페이지는 비운 것으로 봅니다. */
open class CompanyProfileRequest(
    @field:NotBlank
    @field:Size(max = CompanyProfileInput.MAX_REGION_LENGTH)
    val region: String,
    @field:NotBlank
    @field:Size(max = CompanyProfileInput.MAX_INDUSTRY_LENGTH)
    val industry: String,
    @field:Min(1900)
    @field:Max(2100)
    val foundedYear: Int,
    /** 앞뒤 공백은 허용하고 다듬어 저장합니다. 값이 있으면 `http(s)://`로 시작해야 합니다. */
    @field:Size(max = CompanyProfileInput.MAX_HOMEPAGE_LENGTH)
    @field:Pattern(regexp = "\\s*(?i:https?://\\S+)?\\s*")
    val homepageUrl: String? = null,
) {
    fun toProfileInput(): CompanyProfileInput =
        CompanyProfileInput(
            region = region.trim(),
            industry = industry.trim(),
            foundedYear = foundedYear,
            homepageUrl = homepageUrl?.trim()?.ifEmpty { null },
        )
}

/** 등록 요청입니다. 상호·사업자 상태는 서버가 조회 결과로 채우므로 받지 않습니다. */
class RegisterCompanyRequest(
    @field:Pattern(regexp = "[0-9]{3}-?[0-9]{2}-?[0-9]{5}")
    val businessNumber: String,
    region: String,
    industry: String,
    foundedYear: Int,
    homepageUrl: String? = null,
) : CompanyProfileRequest(region, industry, foundedYear, homepageUrl)
