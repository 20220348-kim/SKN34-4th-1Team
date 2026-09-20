package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import org.springframework.http.CacheControl
import org.springframework.http.ProblemDetail
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

@RestControllerAdvice
class ApplicationDocumentExceptionHandler {
    @ExceptionHandler(ApplicationDocumentException::class)
    fun handle(error: ApplicationDocumentException): ResponseEntity<ProblemDetail> {
        val problem = ProblemDetail.forStatusAndDetail(HttpStatus.UNPROCESSABLE_CONTENT, error.message ?: "문서를 생성하지 못했습니다.")
        problem.setProperty("code", error.code)
        return ResponseEntity.unprocessableContent().cacheControl(CacheControl.noStore()).body(problem)
    }
}
