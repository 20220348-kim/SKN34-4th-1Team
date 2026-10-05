package ai.govbiz.core.notification.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.notification.controller.dto.NotificationSettingsRequest
import ai.govbiz.core.notification.controller.dto.NotificationSettingsResponse
import ai.govbiz.core.notification.service.NotificationSettingsService
import jakarta.validation.Valid
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * 로그인 회원 본인의 알림 설정입니다. 소유자는 세션의 계정으로만 정하고, 쿠키가 붙은 변경 요청은 기존 Origin 검사를 거칩니다.
 */
@RestController
@RequestMapping("/api/v1/me/notification-settings")
class NotificationSettingsController(private val service: NotificationSettingsService) {
    @GetMapping
    fun settings(account: Account): ResponseEntity<NotificationSettingsResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(NotificationSettingsResponse.from(service.settings(account)))

    @PutMapping
    fun update(account: Account, @RequestBody @Valid request: NotificationSettingsRequest): ResponseEntity<NotificationSettingsResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(NotificationSettingsResponse.from(
            service.updateDeadlineReminder(account, request.deadlineReminder.toDomain())))
}
