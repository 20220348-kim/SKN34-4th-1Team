package ai.govbiz.core.dailyreport.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.helper.SessionRequestTokenHelper
import ai.govbiz.core.dailyreport.controller.dto.DailyReportPushRequest
import ai.govbiz.core.dailyreport.controller.dto.DailyReportPushSettingsResponse
import ai.govbiz.core.dailyreport.service.DailyReportPushService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import jakarta.validation.constraints.Pattern
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/me/daily-reports/push")
class DailyReportPushController(private val service: DailyReportPushService) {
    @GetMapping
    fun settings(account: Account, @RequestParam @Pattern(regexp = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") deviceId: String)
        = ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(DailyReportPushSettingsResponse.from(service.settings(account, deviceId)))
    @PutMapping
    fun register(account: Account, @RequestBody @Valid body: DailyReportPushRequest, request: HttpServletRequest): ResponseEntity<Void> {
        service.register(account, body.deviceId, body.token, SessionRequestTokenHelper.readBearer(request))
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }
    @DeleteMapping
    fun disable(account: Account, @RequestParam @Pattern(regexp = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") deviceId: String): ResponseEntity<Void> {
        service.disable(account, deviceId)
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }
}
