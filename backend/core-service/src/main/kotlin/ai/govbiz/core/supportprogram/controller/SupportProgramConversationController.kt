package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core.supportprogram.controller.dto.SupportProgramConversationRequest
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramConversationResponse
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.conversation.SupportProgramConversationService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/support-programs/conversation")
class SupportProgramConversationController(
    private val service: SupportProgramConversationService,
    private val admission: SupportProgramRequestAdmissionService,
) {
    @PostMapping("/interpret")
    fun interpret(
        @RequestBody @Valid request: SupportProgramConversationRequest,
        httpRequest: HttpServletRequest,
    ): SupportProgramConversationResponse = admission.execute(httpRequest.remoteAddr) {
        SupportProgramConversationResponse.from(
            service.interpret(
                request.message,
                request.context.toDomain(),
                request.pendingClarification?.toDomain(),
                request.pendingProposal?.toDomain(),
                request.lastSearch?.toDomain(),
            ),
        )
    }
}
