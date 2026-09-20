package ai.govbiz.core.partner.controller.dto

import ai.govbiz.core.partner.domain.PartnerProposalBox
import ai.govbiz.core.partner.domain.PartnerProposalStatus
import ai.govbiz.core.partner.domain.PartnerProposalView

/** 제안함 한 상자입니다. `box`는 요청과 같은 소문자 값이고, 대기 건수는 배지에 씁니다. */
data class PartnerProposalBoxResponse(
    val box: String,
    val proposals: List<PartnerProposalResponse>,
    val pendingCount: Int,
) {
    companion object {
        fun from(box: PartnerProposalBox, proposals: List<PartnerProposalView>, viewerAccountId: Long): PartnerProposalBoxResponse =
            PartnerProposalBoxResponse(
                box = box.name.lowercase(),
                proposals = proposals.map { PartnerProposalResponse.from(it, viewerAccountId) },
                pendingCount = proposals.count { it.status == PartnerProposalStatus.PENDING },
            )
    }
}
