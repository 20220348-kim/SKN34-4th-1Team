package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentService
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFile
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentResponse
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentUnfilledAnswerResponse
import ai.govbiz.core.applicationpreparation.controller.dto.GenerateApplicationDocumentsRequest
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
class ApplicationDocumentController(private val service: ApplicationDocumentService) {
    @GetMapping
    fun list(account: Account, @PathVariable @Min(1) id: Long) = response(service.current(account, id))

    @PostMapping
    fun generate(account: Account, @PathVariable @Min(1) id: Long, @RequestBody @Valid request: GenerateApplicationDocumentsRequest) =
        response(service.generate(account, id, request.expectedRevision))

    @GetMapping("/{fileId}/download")
    fun download(account: Account, @PathVariable @Min(1) id: Long, @PathVariable @Min(1) fileId: Long): ResponseEntity<ByteArray> {
        val file = service.download(account, id, fileId)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .contentType(MediaType.parseMediaType(file.mediaType)).contentLength(file.bytes.size.toLong())
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(file.fileName, StandardCharsets.UTF_8).build().toString())
            .header("X-Content-Type-Options", "nosniff").body(file.bytes)
    }

    private fun response(files: List<ApplicationDocumentFile>) = ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(files.map {
        ApplicationDocumentResponse(it.id, it.inputRevision, it.fileName, it.mediaType, it.bytes.size,
            it.filledAnswerCount, it.filledAnswerCount?.let { _ -> it.unfilledAnswers.size },
            it.unfilledAnswers.map { answer -> ApplicationDocumentUnfilledAnswerResponse(answer.fieldId, answer.fieldLabel, answer.value, answer.reason) })
    })
}
