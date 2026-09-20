package ai.govbiz.core.partner.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.partner.controller.dto.PartnerProposalBoxResponse
import ai.govbiz.core.partner.domain.PartnerProposalBox
import ai.govbiz.core.partner.service.PartnerProposalService
import jakarta.validation.constraints.Pattern
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** 로그인한 회원의 제안함입니다. 받은 제안과 보낸 제안을 상자로 나눠 읽습니다. */
@RestController
@RequestMapping("/api/v1/me/proposals")
class PartnerProposalBoxController(
    private val proposalService: PartnerProposalService,
) {

    /** `box`는 소문자 received·sent입니다. 다른 값은 요청 검증 실패(400)입니다. */
    @GetMapping
    fun box(account: Account, @RequestParam @Pattern(regexp = "received|sent") box: String): PartnerProposalBoxResponse {
        val selected = PartnerProposalBox.valueOf(box.uppercase())
        return PartnerProposalBoxResponse.from(selected, proposalService.findBox(account, selected), account.id)
    }
}
