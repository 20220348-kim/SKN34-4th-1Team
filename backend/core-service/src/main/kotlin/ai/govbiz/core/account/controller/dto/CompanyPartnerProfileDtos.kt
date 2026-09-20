package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.CompanyPartnerProfile
import ai.govbiz.core.account.domain.CompanyPartnerProfileInput
import ai.govbiz.core.partner.domain.PartnerRole
import jakarta.validation.constraints.NotEmpty
import jakarta.validation.constraints.Size
import java.time.format.DateTimeFormatter

/** 협업·파트너 설정 저장 요청입니다. 항목별 문자열은 서버가 앞뒤 공백을 다듬고 빈 값은 버립니다. */
class CompanyPartnerProfileRequest(
    @field:NotEmpty
    @field:Size(max = 3)
    val roles: List<PartnerRole>,
    @field:Size(max = CompanyPartnerProfileInput.MAX_INTEREST_AREA_COUNT)
    val interestAreas: List<@Size(max = CompanyPartnerProfileInput.MAX_INTEREST_AREA_LENGTH) String> = emptyList(),
    @field:Size(max = CompanyPartnerProfileInput.MAX_INTRODUCTION_LENGTH)
    val introduction: String = "",
    @field:Size(max = CompanyPartnerProfileInput.MAX_CAPABILITY_COUNT)
    val capabilities: List<@Size(max = CompanyPartnerProfileInput.MAX_CAPABILITY_LENGTH) String> = emptyList(),
) {
    fun toInput(): CompanyPartnerProfileInput =
        CompanyPartnerProfileInput(
            roles = roles.distinct(),
            interestAreas = interestAreas.map(String::trim).filter(String::isNotEmpty).distinct(),
            introduction = introduction.trim(),
            capabilities = capabilities.map(String::trim).filter(String::isNotEmpty).distinct(),
        )
}

/** `isSet=false`면 아직 저장한 적이 없어 나머지 값은 기본값(빈 목록·빈 문자열)입니다. */
data class CompanyPartnerProfileResponse(
    val isSet: Boolean,
    val roles: List<PartnerRole>,
    val interestAreas: List<String>,
    val introduction: String,
    val capabilities: List<String>,
    val updatedAt: String?,
) {
    companion object {
        private val FORMATTER: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE_TIME

        fun from(profile: CompanyPartnerProfile): CompanyPartnerProfileResponse =
            CompanyPartnerProfileResponse(
                isSet = profile.isSet,
                roles = profile.input?.roles ?: emptyList(),
                interestAreas = profile.input?.interestAreas ?: emptyList(),
                introduction = profile.input?.introduction ?: "",
                capabilities = profile.input?.capabilities ?: emptyList(),
                updatedAt = profile.updatedAt?.format(FORMATTER),
            )
    }
}
