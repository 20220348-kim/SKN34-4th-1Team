package ai.govbiz.core.dailyreport.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.dailyreport.controller.dto.*
import ai.govbiz.core.dailyreport.service.DailyReportService
import ai.govbiz.core.dailyreport.service.DailyReportSubscriptionService
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/me/daily-reports")
class DailyReportController(private val reports: DailyReportService, private val subscriptions: DailyReportSubscriptionService,
    private val admission: SupportProgramRequestAdmissionService) {
    @GetMapping("/settings")
    fun settings(account: Account): ResponseEntity<DailyReportSettingsResponse> = ResponseEntity.ok().cacheControl(CacheControl.noStore())
        .body(DailyReportSettingsResponse.from(subscriptions.settings(account)))

    @PutMapping("/settings")
    fun update(account: Account, @RequestBody @Valid request: DailyReportSettingsRequest): ResponseEntity<DailyReportSettingsResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(DailyReportSettingsResponse.from(
            subscriptions.update(account, request.supportPurpose, request.enabled, request.consent)))

    @PostMapping("/verify-email")
    fun verifyEmail(account: Account, request: HttpServletRequest): ResponseEntity<Void> {
        admission.execute(request.remoteAddr) { subscriptions.requestVerification(account) }
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }

    @GetMapping("/latest")
    fun latest(account: Account): ResponseEntity<DailyReportEnvelopeResponse> = ResponseEntity.ok().cacheControl(CacheControl.noStore())
        .body(DailyReportEnvelopeResponse(reports.latest(account)?.let(DailyReportResponse::from)))

    @PostMapping("/preview")
    fun preview(account: Account): ResponseEntity<DailyReportEnvelopeResponse> = ResponseEntity.ok().cacheControl(CacheControl.noStore())
        .body(DailyReportEnvelopeResponse(DailyReportResponse.from(reports.preview(account))))
}

/** 이메일 링크는 화면에서 토큰을 읽기만 하고 명시적 POST 확인 버튼을 누를 때만 상태를 바꾼다. */
@RestController
@RequestMapping("/api/v1/daily-reports/email")
class DailyReportEmailController(private val subscriptions: DailyReportSubscriptionService,
    private val admission: SupportProgramRequestAdmissionService) {
    @PostMapping("/confirm")
    fun confirm(@RequestBody @Valid request: DailyReportEmailTokenRequest, httpRequest: HttpServletRequest): ResponseEntity<Void> {
        admission.execute(httpRequest.remoteAddr) { subscriptions.confirm(request.token) }
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }

    @PostMapping("/unsubscribe")
    fun unsubscribe(@RequestBody @Valid request: DailyReportEmailTokenRequest, httpRequest: HttpServletRequest): ResponseEntity<Void> {
        admission.execute(httpRequest.remoteAddr) { subscriptions.unsubscribe(request.token) }
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }
}
