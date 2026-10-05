package ai.govbiz.core.admin.controller

import ai.govbiz.core.admin.controller.dto.AdminAuditLogListResponse
import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccessLogQuery
import ai.govbiz.core.admin.service.AdminAccessLogService
import ai.govbiz.core.admin.web.AdminPrincipal
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Positive
import java.time.LocalDate
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/**
 * 관리자 감사 기록(관리자 접속기록) 조회입니다. [AdminPrincipal]로 관리자만 열고, 이 조회도 접속기록에 남습니다.
 * 기록에는 관리자 이메일과 접속 주소가 있으므로 응답은 `Cache-Control: no-store`입니다.
 */
@RestController
@RequestMapping("/api/v1/admin/audit-logs")
class AdminAuditLogController(
    private val service: AdminAccessLogService,
) {

    /** 조건을 비우면 전체이고 최신 기록부터 `limit`(1~50, 기본 50)건씩 돌려줍니다. 기간 `from`·`to`는 서울 기준 날짜(끝 날 포함)입니다. */
    @GetMapping
    fun list(
        admin: AdminPrincipal,
        @RequestParam(required = false) @Positive actorAccountId: Long?,
        @RequestParam(required = false) @Positive targetAccountId: Long?,
        @RequestParam(required = false) action: AdminAccessAction?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) from: LocalDate?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) to: LocalDate?,
        @RequestParam(required = false) @Positive before: Long?,
        @RequestParam(defaultValue = "50") @Min(1) @Max(AdminAccessLogQuery.MAX_LIMIT.toLong()) limit: Int,
    ): ResponseEntity<AdminAuditLogListResponse> {
        val query = AdminAccessLogQuery(
            actorAccountId = actorAccountId,
            targetAccountId = targetAccountId,
            action = action,
            from = from,
            to = to,
            before = before,
            limit = limit,
        )
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(AdminAuditLogListResponse.from(service.findPage(admin.actor, query)))
    }
}
