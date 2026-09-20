package ai.govbiz.core.dailyreport.controller

import ai.govbiz.core.dailyreport.client.exception.DailyReportMailException
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import java.net.URI
import org.springframework.core.annotation.Order
import org.springframework.http.CacheControl
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ProblemDetail
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

@Order(-1)
@RestControllerAdvice(assignableTypes = [DailyReportController::class, DailyReportEmailController::class])
class DailyReportExceptionHandler {
    @ExceptionHandler(DailyReportException::class)
    fun report(error: DailyReportException): ResponseEntity<ProblemDetail> = response(error.code)

    @ExceptionHandler(DailyReportMailException::class)
    fun mail(): ResponseEntity<ProblemDetail> = response(DailyReportErrorCode.EMAIL_DELIVERY_UNAVAILABLE)

    private fun response(code: DailyReportErrorCode): ResponseEntity<ProblemDetail> {
        val status = when (code) {
            DailyReportErrorCode.EMAIL_VERIFICATION_RATE_LIMITED, DailyReportErrorCode.REPORT_CAPACITY_EXCEEDED,
            DailyReportErrorCode.REPORT_DAILY_BUDGET_EXCEEDED -> HttpStatus.TOO_MANY_REQUESTS
            DailyReportErrorCode.EMAIL_DELIVERY_UNAVAILABLE, DailyReportErrorCode.SEARCH_NOT_READY -> HttpStatus.SERVICE_UNAVAILABLE
            DailyReportErrorCode.EMAIL_CONFIRMATION_REQUIRED, DailyReportErrorCode.EMAIL_CONSENT_REQUIRED -> HttpStatus.CONFLICT
            DailyReportErrorCode.INVALID_EMAIL_TOKEN -> HttpStatus.BAD_REQUEST
        }
        val detail = when (code) {
            DailyReportErrorCode.EMAIL_CONFIRMATION_REQUIRED -> "리포트 수신 이메일을 먼저 확인해 주세요."
            DailyReportErrorCode.EMAIL_CONSENT_REQUIRED -> "정기 리포트 이메일 수신 동의가 필요합니다."
            DailyReportErrorCode.EMAIL_DELIVERY_UNAVAILABLE -> "현재 이메일 발송을 사용할 수 없습니다."
            DailyReportErrorCode.EMAIL_VERIFICATION_RATE_LIMITED -> "인증 이메일은 5분 후 다시 요청할 수 있습니다."
            DailyReportErrorCode.INVALID_EMAIL_TOKEN -> "이메일 링크가 올바르지 않거나 만료되었습니다."
            DailyReportErrorCode.REPORT_CAPACITY_EXCEEDED -> "다른 리포트를 생성하고 있습니다. 잠시 후 다시 시도해 주세요."
            DailyReportErrorCode.REPORT_DAILY_BUDGET_EXCEEDED -> "오늘의 리포트 생성 한도에 도달했습니다. 내일 다시 시도해 주세요."
            DailyReportErrorCode.SEARCH_NOT_READY -> "검색할 공고 데이터가 아직 준비되지 않았습니다."
        }
        val problem = ProblemDetail.forStatusAndDetail(status, detail)
        problem.title = "Daily Report Request Failed"
        problem.type = URI.create("urn:govbiz:problem:daily-report")
        problem.setProperty("code", code.name)
        val builder = ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON).cacheControl(CacheControl.noStore())
        if (code == DailyReportErrorCode.EMAIL_VERIFICATION_RATE_LIMITED) builder.header("Retry-After", "300")
        if (code == DailyReportErrorCode.REPORT_CAPACITY_EXCEEDED) builder.header("Retry-After", "5")
        return builder.body(problem)
    }
}
