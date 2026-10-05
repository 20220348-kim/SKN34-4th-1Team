package ai.govbiz.core.notification.controller

import ai.govbiz.core.notification.domain.exception.NotificationSettingsErrorCode
import ai.govbiz.core.notification.domain.exception.NotificationSettingsException
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
@RestControllerAdvice(assignableTypes = [NotificationSettingsController::class])
class NotificationSettingsExceptionHandler {
    @ExceptionHandler(NotificationSettingsException::class)
    fun settings(error: NotificationSettingsException): ResponseEntity<ProblemDetail> {
        val (status, detail) = when (error.code) {
            NotificationSettingsErrorCode.EMAIL_CONFIRMATION_REQUIRED ->
                HttpStatus.CONFLICT to "맞춤 리포트 화면에서 수신 이메일 주소를 먼저 확인해 주세요."
            NotificationSettingsErrorCode.EMAIL_DELIVERY_UNAVAILABLE ->
                HttpStatus.SERVICE_UNAVAILABLE to "지금은 이메일 발송을 사용할 수 없어요."
            NotificationSettingsErrorCode.PUSH_DELIVERY_UNAVAILABLE ->
                HttpStatus.SERVICE_UNAVAILABLE to "지금은 앱 알림 발송을 사용할 수 없어요."
        }
        val problem = ProblemDetail.forStatusAndDetail(status, detail)
        problem.title = "Notification Settings Request Failed"
        problem.type = URI.create("urn:govbiz:problem:notification-settings")
        problem.setProperty("code", error.code.name)
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON).cacheControl(CacheControl.noStore())
            .body(problem)
    }
}
