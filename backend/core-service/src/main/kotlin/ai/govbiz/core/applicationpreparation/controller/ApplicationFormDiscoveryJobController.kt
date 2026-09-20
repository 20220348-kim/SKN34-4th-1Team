package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationFormDiscoveryJobRequest
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationFormDiscoveryJobResponse
import ai.govbiz.core.applicationpreparation.service.ApplicationFormDiscoveryJobService
import jakarta.validation.Valid
import jakarta.validation.constraints.Min
import java.net.URI
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/application-preparations/forms/discovery-jobs")
class ApplicationFormDiscoveryJobController(private val service: ApplicationFormDiscoveryJobService) {
    @PostMapping
    fun submit(account: Account, @RequestBody @Valid request: ApplicationFormDiscoveryJobRequest): ResponseEntity<ApplicationFormDiscoveryJobResponse> {
        val job = service.submit(account, request.requestKey, request.sourceCode, request.sourceProgramId)
        return ResponseEntity.accepted().location(URI.create("/api/v1/application-preparations/forms/discovery-jobs/${job.id}"))
            .cacheControl(CacheControl.noStore()).body(ApplicationFormDiscoveryJobResponse.from(job))
    }

    @GetMapping("/{id}")
    fun get(account: Account, @PathVariable @Min(1) id: Long): ResponseEntity<ApplicationFormDiscoveryJobResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ApplicationFormDiscoveryJobResponse.from(service.get(account, id)))

    @GetMapping
    fun list(account: Account): ResponseEntity<List<ApplicationFormDiscoveryJobResponse>> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.list(account).map(ApplicationFormDiscoveryJobResponse::from))
}
