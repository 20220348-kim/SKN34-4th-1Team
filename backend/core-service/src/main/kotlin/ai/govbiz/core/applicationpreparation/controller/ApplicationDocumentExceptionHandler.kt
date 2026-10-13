package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentDownloadLinkException
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentMigrationNoticeResponse
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentMappingChangeResponse
import org.springframework.http.CacheControl
import org.springframework.http.ProblemDetail
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

@RestControllerAdvice
class ApplicationDocumentExceptionHandler {
    @ExceptionHandler(ApplicationDocumentDownloadLinkException::class)
    fun downloadLink(error: ApplicationDocumentDownloadLinkException): ResponseEntity<ProblemDetail> {
        val problem = ProblemDetail.forStatusAndDetail(HttpStatus.GONE, error.message!!)
        problem.setProperty("code", "APPLICATION_DOCUMENT_DOWNLOAD_LINK_INVALID")
        return ResponseEntity.status(HttpStatus.GONE).cacheControl(CacheControl.noStore())
            .header("Referrer-Policy", "no-referrer").body(problem)
    }

    @ExceptionHandler(ApplicationDocumentException::class)
    fun handle(error: ApplicationDocumentException): ResponseEntity<ProblemDetail> {
        val status = if (error.code == "APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE") HttpStatus.SERVICE_UNAVAILABLE
            else HttpStatus.UNPROCESSABLE_CONTENT
        val problem = ProblemDetail.forStatusAndDetail(status, error.message ?: "문서를 생성하지 못했습니다.")
        problem.setProperty("code", error.code)
        error.mappingMigration?.let { notice ->
            problem.setProperty("mappingMigration", ApplicationDocumentMigrationNoticeResponse(
                approvalToken = notice.approvalToken, expectedRevision = notice.expectedRevision,
                expiresInSeconds = notice.expiresInSeconds,
                changes = notice.changes.map {
                    ApplicationDocumentMappingChangeResponse(it.fieldLabel, it.changeType, it.oldLocation, it.newLocation)
                }))
        }
        return ResponseEntity.status(status).cacheControl(CacheControl.noStore()).body(problem)
    }
}
