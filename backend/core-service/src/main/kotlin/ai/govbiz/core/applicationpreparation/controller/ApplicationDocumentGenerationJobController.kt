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
@RequestMapping("/api/v1/application-preparations")
class ApplicationDocumentGenerationJobController(private val service: ApplicationDocumentGenerationJobService) {
    @PostMapping("/{id}/documents/jobs")
    fun submit(account: Account, @PathVariable @Min(1) id: Long,
               @RequestBody @Valid request: ApplicationDocumentGenerationJobRequest): ResponseEntity<ApplicationDocumentGenerationJobResponse> {
        val job = service.submit(account, id, request.requestKey, request.expectedRevision)
        return ResponseEntity.accepted().location(URI.create("/api/v1/application-preparations/$id/documents/jobs/${job.id}"))
            .cacheControl(CacheControl.noStore()).body(ApplicationDocumentGenerationJobResponse.from(job, null))
    }

    @GetMapping("/{id}/documents/jobs/{jobId}")
    fun get(account: Account, @PathVariable @Min(1) id: Long, @PathVariable @Min(1) jobId: Long): ResponseEntity<ApplicationDocumentGenerationJobResponse> {
        val job = service.get(account, id, jobId)
        val migration = if (job.failureCode == "APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED") service.mappingMigration(account, id, jobId) else null
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ApplicationDocumentGenerationJobResponse.from(job, migration))
    }

    @GetMapping("/{id}/documents/jobs")
    fun list(account: Account, @PathVariable @Min(1) id: Long): ResponseEntity<List<ApplicationDocumentGenerationJobResponse>> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(service.list(account, id).map { ApplicationDocumentGenerationJobResponse.from(it, null) })

    /** 그 준비 건의 끝난 생성 결과를 확인한 것으로 표시한다. 화면이 초안 화면을 열 때 부른다. */
    @PostMapping("/{id}/documents/jobs/seen")
    fun markSeen(account: Account, @PathVariable @Min(1) id: Long): ResponseEntity<Void> {
        service.markSeen(account, id)
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }

    /** 계정의 최근 작업(준비 건 구분 없음). 목록 화면이 초안을 만드는 중인 준비 건을 표시할 때 읽는다. */
    @GetMapping("/documents/jobs")
    fun listRecent(account: Account): ResponseEntity<List<ApplicationDocumentGenerationJobResponse>> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(service.listRecent(account).map { ApplicationDocumentGenerationJobResponse.from(it, null) })
}
