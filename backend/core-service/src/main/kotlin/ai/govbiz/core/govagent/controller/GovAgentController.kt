package ai.govbiz.core.govagent.controller

import ai.govbiz.core.admin.web.AdminPrincipal
import ai.govbiz.core.govagent.controller.dto.GovAgentMessageRequest
import ai.govbiz.core.govagent.controller.dto.GovAgentMessageResponse
import ai.govbiz.core.govagent.service.GovAgentService
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/gov-agent")
class GovAgentController(
    private val service: GovAgentService,
    private val admission: SupportProgramRequestAdmissionService,
) {
    @PostMapping("/messages")
    fun answer(admin: AdminPrincipal, @Valid @RequestBody request: GovAgentMessageRequest, httpRequest: HttpServletRequest): ResponseEntity<GovAgentMessageResponse> =
        admission.execute(httpRequest.remoteAddr) {
            ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
                GovAgentMessageResponse.from(service.answer(admin.account, httpRequest.remoteAddr, request.toDomain(), sampleProduction = httpRequest.getHeader("X-GovBiz-Evaluation") == null)),
            )
        }
}
