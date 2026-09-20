package ai.govbiz.core.partner.controller.dto

import ai.govbiz.core.partner.domain.PartnerProposalInput
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size

/** 제안 보내기 요청입니다. 제안 기업은 세션 계정의 등록 기업을 씁니다. */
class SendPartnerProposalRequest(
    @field:NotBlank
    @field:Size(max = PartnerProposalInput.MAX_MESSAGE_LENGTH)
    val message: String,
    /** 기업 기본정보(소재지·업종·설립연도)를 모집글 작성자에게 함께 보여 줄지입니다. */
    val shareProfile: Boolean = true,
) {
    fun toInput(): PartnerProposalInput = PartnerProposalInput(message = message.trim(), shareProfile = shareProfile)
}
