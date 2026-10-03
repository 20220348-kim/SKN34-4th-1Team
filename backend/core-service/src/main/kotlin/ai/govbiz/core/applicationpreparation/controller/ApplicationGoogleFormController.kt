package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationGoogleFormResponse
import ai.govbiz.core.applicationpreparation.service.ApplicationGoogleFormService
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/application-preparations/google-form")
class ApplicationGoogleFormController(private val service: ApplicationGoogleFormService) {
    @GetMapping
    fun read(account: Account, @RequestParam sourceCode: String, @RequestParam sourceProgramId: String): ResponseEntity<ApplicationGoogleFormResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(ApplicationGoogleFormResponse.from(service.read(account, sourceCode, sourceProgramId)))
}
