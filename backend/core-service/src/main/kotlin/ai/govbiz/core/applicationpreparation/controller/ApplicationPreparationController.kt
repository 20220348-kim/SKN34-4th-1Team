package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationPreparationPageResponse
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationPreparationResponse
import ai.govbiz.core.applicationpreparation.controller.dto.CreateApplicationPreparationRequest
import ai.govbiz.core.applicationpreparation.controller.dto.SupportedApplicationFormsResponse
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationInterpretationResponse
import ai.govbiz.core.applicationpreparation.controller.dto.InterpretApplicationPreparationRequest
import ai.govbiz.core.applicationpreparation.controller.dto.ReplaceApplicationPreparationInputsRequest
import ai.govbiz.core.applicationpreparation.controller.dto.UpdateApplicationProgressRequest
import ai.govbiz.core.applicationpreparation.controller.dto.DiscoverApplicationFormsRequest
import ai.govbiz.core.applicationpreparation.controller.dto.DiscoveredApplicationFormsResponse
import ai.govbiz.core.applicationpreparation.service.ApplicationFormDiscoveryService
import ai.govbiz.core.applicationpreparation.service.ApplicationPreparationService
import ai.govbiz.core.applicationpreparation.domain.ApplicationPreparationListStatus
import ai.govbiz.core.applicationpreparation.domain.exception.InvalidApplicationPreparationInputException
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import java.net.URI
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.beans.factory.annotation.Value
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.applicationpreparation.controller.dto.GenerateApplicationDraftRequest
import ai.govbiz.core.applicationpreparation.controller.dto.SaveApplicationContentRequest
import ai.govbiz.core.applicationpreparation.controller.dto.ConfirmApplicationContentRequest
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService

@RestController
@RequestMapping("/api/v1/application-preparations")
class ApplicationPreparationController(
    private val service: ApplicationPreparationService,
    private val discovery: ApplicationFormDiscoveryService,
    @param:Value("\${app.application-form-discovery.queue.enabled:false}") private val discoveryQueueEnabled: Boolean,
    private val admission: SupportProgramRequestAdmissionService,
) {
    @GetMapping("/forms")
    fun forms(account: Account): ResponseEntity<SupportedApplicationFormsResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(SupportedApplicationFormsResponse.from(service.supportedForms(account)))

    @PostMapping("/forms/discover")
    fun discoverForms(
        account: Account,
        @RequestBody @Valid request: DiscoverApplicationFormsRequest,
    ): ResponseEntity<DiscoveredApplicationFormsResponse> {
        // 큐 사용 환경에서 구형 API로 동시 실행 제한·멱등 처리를 우회할 수 없다.
        if (discoveryQueueEnabled) throw ApplicationFormDiscoveryException(ApplicationFormDiscoveryException.Reason.JOB_CONFLICT)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
            DiscoveredApplicationFormsResponse.from(discovery.discover(account, request.sourceCode, request.sourceProgramId)),
        )
    }

    @PostMapping
    fun create(
        account: Account,
        @RequestBody @Valid request: CreateApplicationPreparationRequest,
    ): ResponseEntity<ApplicationPreparationResponse> {
        val result = service.create(account, request.toDraft())
        return ResponseEntity.created(URI.create("/api/v1/application-preparations/${result.preparation.id}"))
            .cacheControl(CacheControl.noStore())
            .body(ApplicationPreparationResponse.from(result))
    }

    @GetMapping
    fun list(
        account: Account,
        @RequestParam(required = false) @Min(1) beforeId: Long?,
        @RequestParam(defaultValue = "20") @Min(1) @Max(50) size: Int,
        @RequestParam(required = false) status: String?,
    ): ResponseEntity<ApplicationPreparationPageResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(ApplicationPreparationPageResponse.from(service.listOwned(account, beforeId, size, listStatus(status))))

    private fun listStatus(value: String?): ApplicationPreparationListStatus? = when (value) {
        null, "" -> null
        "in_progress" -> ApplicationPreparationListStatus.IN_PROGRESS
        "done" -> ApplicationPreparationListStatus.DONE
        else -> throw InvalidApplicationPreparationInputException()
    }

    @GetMapping("/{id}/online-input-guide")
    fun onlineInputGuide(account: Account, @PathVariable @Min(1) id: Long):
        ResponseEntity<ai.govbiz.core.applicationpreparation.controller.dto.ApplicationOnlineInputGuideResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
            ai.govbiz.core.applicationpreparation.controller.dto.ApplicationOnlineInputGuideResponse.from(service.onlineInputGuide(account, id)),
        )

    @GetMapping("/{id}")
    fun detail(
        account: Account,
        @PathVariable @Min(1) id: Long,
    ): ResponseEntity<ApplicationPreparationResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(ApplicationPreparationResponse.from(service.findOwned(account, id)))

    @DeleteMapping("/{id}")
    fun delete(
        account: Account,
        @PathVariable @Min(1) id: Long,
    ): ResponseEntity<Void> {
        service.deleteOwned(account, id)
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }

    @PutMapping("/{id}/progress-stage")
    fun updateProgress(
        account: Account,
        @PathVariable @Min(1) id: Long,
        @RequestBody @Valid request: UpdateApplicationProgressRequest,
    ): ResponseEntity<ApplicationPreparationResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
            ApplicationPreparationResponse.from(
                service.updateProgress(account, id, request.expectedProgressRevision, request.toProgressStage()),
            ),
        )

    @PostMapping("/{id}/sections/{sectionKey}/messages")
    fun interpret(
        account: Account,
        @PathVariable @Min(1) id: Long,
        @PathVariable sectionKey: String,
        @RequestBody @Valid request: InterpretApplicationPreparationRequest,
    ): ResponseEntity<ApplicationInterpretationResponse> = sectionAi(account) {
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
            ApplicationInterpretationResponse.from(
                service.interpret(account, id, sectionKey, request.expectedRevision, request.requestKey, request.message.trim()),
            ),
        )
    }

    @PutMapping("/{id}/sections/{sectionKey}/inputs")
    fun replaceInputs(
        account: Account,
        @PathVariable @Min(1) id: Long,
        @PathVariable sectionKey: String,
        @RequestBody @Valid request: ReplaceApplicationPreparationInputsRequest,
    ): ResponseEntity<ApplicationPreparationResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
            ApplicationPreparationResponse.from(service.replaceInputs(account, id, sectionKey, request.expectedRevision, request.toFacts())),
        )

    @PostMapping("/{id}/sections/{sectionKey}/drafts")
    fun draft(account: Account, @PathVariable @Min(1) id: Long, @PathVariable sectionKey: String,
              @RequestBody @Valid request: GenerateApplicationDraftRequest): ResponseEntity<ApplicationPreparationResponse> =
        sectionAi(account) {
            ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ApplicationPreparationResponse.from(
                service.generateDraft(account, id, sectionKey, request.expectedRevision, request.expectedVersionId, request.requestKey),
            ))
        }

    @PutMapping("/{id}/sections/{sectionKey}/content")
    fun saveContent(account: Account, @PathVariable @Min(1) id: Long, @PathVariable sectionKey: String,
                    @RequestBody @Valid request: SaveApplicationContentRequest): ResponseEntity<ApplicationPreparationResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ApplicationPreparationResponse.from(
            service.saveContent(account, id, sectionKey, request.expectedRevision, request.expectedVersionId, request.content),
        ))

    @PostMapping("/{id}/sections/{sectionKey}/confirmations")
    fun confirmContent(account: Account, @PathVariable @Min(1) id: Long, @PathVariable sectionKey: String,
                       @RequestBody @Valid request: ConfirmApplicationContentRequest): ResponseEntity<ApplicationPreparationResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ApplicationPreparationResponse.from(
            service.confirmContent(account, id, sectionKey, request.expectedRevision, request.expectedVersionId),
        ))

    /** 문항별 AI 해석·초안은 다른 AI 경로처럼 계정별 분당 요청량과 공유 동시 실행 한도를 지킨다. */
    private fun <T> sectionAi(account: Account, action: () -> T): T =
        admission.execute("application-section-ai:${account.id}", action)
}
