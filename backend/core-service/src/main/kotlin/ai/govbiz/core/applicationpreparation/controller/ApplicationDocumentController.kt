package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentService
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentDownloadLinkService
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentDownloadLinkResponse
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFile
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentResponse
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentUnfilledAnswerResponse
import ai.govbiz.core.applicationpreparation.controller.dto.GenerateApplicationDocumentsRequest
import ai.govbiz.core.applicationpreparation.controller.dto.ConfirmApplicationDocumentMigrationRequest
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentMigrationConfirmedResponse
import jakarta.validation.Valid
import jakarta.validation.constraints.Min
import org.springframework.http.CacheControl
import org.springframework.http.ContentDisposition
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.nio.charset.StandardCharsets

@RestController
@RequestMapping("/api/v1/application-preparations/{id}/documents")
class ApplicationDocumentController(
    private val service: ApplicationDocumentService,
    private val downloadLinks: ApplicationDocumentDownloadLinkService,
) {
    @GetMapping
    fun list(account: Account, @PathVariable @Min(1) id: Long) = response(service.current(account, id))

    @PostMapping
    fun generate(account: Account, @PathVariable @Min(1) id: Long, @RequestBody @Valid request: GenerateApplicationDocumentsRequest) =
        response(service.generate(account, id, request.expectedRevision))

    @PostMapping("/mapping-migration/confirm")
    fun confirmMigration(account: Account, @PathVariable @Min(1) id: Long,
                         @RequestBody @Valid request: ConfirmApplicationDocumentMigrationRequest) =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(service.confirmMigration(account, id, request.expectedRevision, request.approvalToken).let {
                ApplicationDocumentMigrationConfirmedResponse(preparationId = it.preparationId,
                    inputRevision = it.inputRevision, formVersionId = it.formVersionId)
            })

    @PostMapping("/{fileId}/download-link")
    fun downloadLink(account: Account, @PathVariable @Min(1) id: Long, @PathVariable @Min(1) fileId: Long) =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(ApplicationDocumentDownloadLinkResponse.from(downloadLinks.create(account, id, fileId)))

    @GetMapping(value = ["/{fileId}/download"], params = ["!ticket"])
    fun download(account: Account, @PathVariable @Min(1) id: Long, @PathVariable @Min(1) fileId: Long): ResponseEntity<ByteArray> {
        val file = service.download(account, id, fileId)
        return attachment(file.fileName, file.mediaType, file.bytes)
    }

    @GetMapping(value = ["/{fileId}/download"], params = ["ticket"])
    fun browserDownload(@PathVariable @Min(1) id: Long, @PathVariable @Min(1) fileId: Long,
                        @RequestParam ticket: String): ResponseEntity<ByteArray> {
        val file = downloadLinks.download(id, fileId, ticket)
        return attachment(file.fileName, file.mediaType, file.bytes)
    }

    @GetMapping("/archive")
    fun archive(account: Account, @PathVariable @Min(1) id: Long, @RequestParam @Min(1) revision: Long): ResponseEntity<ByteArray> {
        val archive = service.archive(account, id, revision)
        return attachment(archive.fileName, archive.mediaType, archive.bytes).let {
            ResponseEntity.status(it.statusCode).headers(it.headers).header("X-Archive-File-Count", archive.fileCount.toString()).body(it.body)
        }
    }

    private fun attachment(fileName: String, mediaType: String, bytes: ByteArray): ResponseEntity<ByteArray> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .contentType(MediaType.parseMediaType(mediaType)).contentLength(bytes.size.toLong())
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(fileName, StandardCharsets.UTF_8).build().toString())
            .header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer").body(bytes)

    private fun response(files: List<ApplicationDocumentFile>) = ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(files.map {
        ApplicationDocumentResponse(it.id, it.inputRevision, it.fileName, it.mediaType, it.bytes.size,
            it.filledAnswerCount, it.filledAnswerCount?.let { _ -> it.unfilledAnswers.size },
            it.unfilledAnswers.map { answer -> ApplicationDocumentUnfilledAnswerResponse(answer.fieldId, answer.fieldLabel, answer.value, answer.reason, answer.capacity) },
            it.remainingExampleCount)
    })
}
