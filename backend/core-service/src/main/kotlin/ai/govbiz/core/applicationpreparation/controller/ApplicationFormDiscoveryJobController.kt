package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationFormDiscoveryJobRequest
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationFormDiscoveryJobResponse
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationFormDiscoverySeenRequest
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

    /** 한 공고의 끝난 분석 결과를 확인한 것으로 표시한다. 화면이 그 공고의 새 문서 화면을 열 때 부른다. */
    @PostMapping("/seen")
    fun markSeen(account: Account, @RequestBody @Valid request: ApplicationFormDiscoverySeenRequest): ResponseEntity<Void> {
        service.markSeen(account, request.sourceCode, request.sourceProgramId)
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }
}
