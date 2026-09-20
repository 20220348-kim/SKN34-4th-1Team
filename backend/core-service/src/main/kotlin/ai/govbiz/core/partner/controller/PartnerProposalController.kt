package ai.govbiz.core.partner.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.partner.controller.dto.PartnerProposalResponse
import ai.govbiz.core.partner.controller.dto.SendPartnerProposalRequest
import ai.govbiz.core.partner.service.PartnerProposalService
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 파트너 제안입니다. 모든 요청은 세션이 필요하고 당사자만 제안을 읽고 처리할 수 있습니다. */
@RestController
@RequestMapping("/api/v1/partners")
class PartnerProposalController(
    private val proposalService: PartnerProposalService,
) {

    @PostMapping("/recruitments/{recruitmentId}/proposals")
    fun send(
        account: Account,
        @PathVariable recruitmentId: Long,
        @RequestBody @Valid request: SendPartnerProposalRequest,
    ): ResponseEntity<PartnerProposalResponse> {
        val proposal = proposalService.send(account, recruitmentId, request.toInput())
        return ResponseEntity.status(HttpStatus.CREATED).body(PartnerProposalResponse.from(proposal, account.id))
    }

    @GetMapping("/proposals/{id}")
    fun detail(account: Account, @PathVariable id: Long): PartnerProposalResponse =
        PartnerProposalResponse.from(proposalService.findView(account, id), account.id)

    @PostMapping("/proposals/{id}/accept")
    fun accept(account: Account, @PathVariable id: Long): PartnerProposalResponse =
        PartnerProposalResponse.from(proposalService.accept(account, id), account.id)

    @PostMapping("/proposals/{id}/decline")
    fun decline(account: Account, @PathVariable id: Long): PartnerProposalResponse =
        PartnerProposalResponse.from(proposalService.decline(account, id), account.id)

    @PostMapping("/proposals/{id}/withdraw")
    fun withdraw(account: Account, @PathVariable id: Long): PartnerProposalResponse =
        PartnerProposalResponse.from(proposalService.withdraw(account, id), account.id)
}
