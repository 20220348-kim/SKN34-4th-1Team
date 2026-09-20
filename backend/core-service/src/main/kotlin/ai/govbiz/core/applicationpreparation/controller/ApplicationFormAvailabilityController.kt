package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationFormAvailabilityResponse
import ai.govbiz.core.applicationpreparation.service.ApplicationFormAvailabilityService
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/application-preparations/forms/availability")
class ApplicationFormAvailabilityController(private val service: ApplicationFormAvailabilityService) {
    @GetMapping
    fun get(account: Account, @RequestParam sourceCode: String, @RequestParam sourceProgramId: String): ResponseEntity<ApplicationFormAvailabilityResponse> {
        require(account.id > 0)
        val (state, forms) = service.get(sourceCode, sourceProgramId)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ApplicationFormAvailabilityResponse.from(state, forms))
    }
}
