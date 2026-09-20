package ai.govbiz.core.partner.controller.dto

import ai.govbiz.core.partner.domain.PartnerRecruitmentInput
import ai.govbiz.core.partner.domain.PartnerRole
import jakarta.validation.constraints.AssertTrue
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.time.LocalDate

/** 모집글 수정 요청입니다. 묶인 공고는 바꿀 수 없으므로 작성 요청에서 공고 식별자를 뺀 내용만 받습니다. */
class UpdatePartnerRecruitmentRequest(
    @field:NotBlank
    @field:Size(max = PartnerRecruitmentInput.MAX_TITLE_LENGTH)
    val title: String,
    @field:NotBlank
    @field:Size(max = PartnerRecruitmentInput.MAX_BODY_LENGTH)
    val body: String,
    val ownRole: PartnerRole,
    val seekingRole: PartnerRole,
    @field:Min(1)
    @field:Max(9)
    val seekingCount: Int,
    @field:NotBlank
    @field:Size(max = PartnerRecruitmentInput.MAX_REGION_LENGTH)
    val region: String,
    /** 비우면 업력 무관입니다. */
    @field:Min(1)
    @field:Max(50)
    val minimumCompanyAgeYears: Int? = null,
    @field:Size(max = PartnerRecruitmentInput.MAX_CAPABILITY_COUNT)
    val capabilities: List<@NotBlank @Size(max = PartnerRecruitmentInput.MAX_CAPABILITY_LENGTH) String> = emptyList(),
    val recruitmentDeadline: LocalDate,
) {
    /** 우리 기업은 주관기관이나 참여기관만 될 수 있습니다. 수요처는 찾는 역할로만 씁니다. */
    @get:AssertTrue
    val ownRoleAllowed: Boolean
        get() = ownRole != PartnerRole.DEMAND

    /** 같은 역량이 두 번 들어오면 한 번만 저장합니다. 작성 요청과 같은 정리 규칙입니다. */
    fun toInput(): PartnerRecruitmentInput =
        PartnerRecruitmentInput(
            title = title.trim(),
            body = body.trim(),
            ownRole = ownRole,
            seekingRole = seekingRole,
            seekingCount = seekingCount,
            region = region.trim(),
            minimumCompanyAgeYears = minimumCompanyAgeYears,
            capabilities = capabilities.map(String::trim).distinct(),
            recruitmentDeadline = recruitmentDeadline,
        )
}
