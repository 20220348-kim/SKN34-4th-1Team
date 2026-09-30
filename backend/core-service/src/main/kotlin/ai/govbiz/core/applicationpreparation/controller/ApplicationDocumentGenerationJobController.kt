package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentGenerationJobRequest
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentGenerationJobResponse
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentGenerationJobService
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
@RequestMapping("/api/v1/application-preparations/{id}/documents/jobs")
class ApplicationDocumentGenerationJobController(private val service: ApplicationDocumentGenerationJobService) {
    @PostMapping
    fun submit(account: Account, @PathVariable @Min(1) id: Long,
               @RequestBody @Valid request: ApplicationDocumentGenerationJobRequest): ResponseEntity<ApplicationDocumentGenerationJobResponse> {
        val job = service.submit(account, id, request.requestKey, request.expectedRevision)
        return ResponseEntity.accepted().location(URI.create("/api/v1/application-preparations/$id/documents/jobs/${job.id}"))
            .cacheControl(CacheControl.noStore()).body(ApplicationDocumentGenerationJobResponse.from(job, null))
    }

    @GetMapping("/{jobId}")
    fun get(account: Account, @PathVariable @Min(1) id: Long, @PathVariable @Min(1) jobId: Long): ResponseEntity<ApplicationDocumentGenerationJobResponse> {
        val job = service.get(account, id, jobId)
        val migration = if (job.failureCode == "APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED") service.mappingMigration(account, id, jobId) else null
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ApplicationDocumentGenerationJobResponse.from(job, migration))
    }

    @GetMapping
    fun list(account: Account, @PathVariable @Min(1) id: Long): ResponseEntity<List<ApplicationDocumentGenerationJobResponse>> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(service.list(account, id).map { ApplicationDocumentGenerationJobResponse.from(it, null) })
}
