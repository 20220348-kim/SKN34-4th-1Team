package ai.govbiz.core.admin.controller

import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.admin.controller.dto.AdminAccountActionRequest
import ai.govbiz.core.admin.controller.dto.AdminAccountDetailResponse
import ai.govbiz.core.admin.controller.dto.AdminAccountListResponse
import ai.govbiz.core.admin.controller.dto.AdminAccountStatsResponse
import ai.govbiz.core.admin.domain.AdminAccountLoginMethod
import ai.govbiz.core.admin.domain.AdminAccountQuery
import ai.govbiz.core.admin.domain.AdminAccountSort
import ai.govbiz.core.admin.domain.AdminAccountStatus
import ai.govbiz.core.admin.service.AdminAccountService
import ai.govbiz.core.admin.web.AdminPrincipal
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Size
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/**
 * 관리자 계정 관리입니다. 모든 메서드가 [AdminPrincipal]을 받으므로 세션이 없으면 401, 관리자가 아니면 403입니다.
 * 조치(POST)는 세션 쿠키가 붙은 상태 변경이라 account 설정의 Origin 검사도 거칩니다.
 */
@RestController
@RequestMapping("/api/v1/admin/accounts")
class AdminAccountController(
    private val service: AdminAccountService,
) {

    @GetMapping("/summary")
    fun summary(admin: AdminPrincipal): AdminAccountStatsResponse =
        AdminAccountStatsResponse.from(service.stats())

    /** 삭제된 계정은 나오지 않습니다. 상태·역할·로그인 방법을 비우면 전체입니다. */
    @GetMapping
    fun list(
        admin: AdminPrincipal,
        @RequestParam(defaultValue = "") @Size(max = AdminAccountQuery.MAX_KEYWORD_LENGTH) keyword: String,
        @RequestParam(required = false) status: AdminAccountStatus?,
        @RequestParam(required = false) role: AccountRole?,
        @RequestParam(required = false) loginMethod: AdminAccountLoginMethod?,
        @RequestParam(defaultValue = "RECENT") sort: AdminAccountSort,
        @RequestParam(defaultValue = "1") @Min(1) @Max(100_000) page: Int,
        @RequestParam(defaultValue = "20") @Min(1) @Max(AdminAccountQuery.MAX_PAGE_SIZE.toLong()) pageSize: Int,
    ): AdminAccountListResponse {
        val query = AdminAccountQuery(
            keyword = keyword.trim(),
            status = status,
            role = role,
            loginMethod = loginMethod,
            sort = sort,
            page = page,
            pageSize = pageSize,
        )
        return AdminAccountListResponse.from(service.findPage(query))
    }

    @GetMapping("/{id}")
    fun detail(admin: AdminPrincipal, @PathVariable id: Long): AdminAccountDetailResponse =
        AdminAccountDetailResponse.from(service.detail(id), admin.account.id)

    @PostMapping("/{id}/suspend")
    fun suspend(
        admin: AdminPrincipal,
        @PathVariable id: Long,
        @RequestBody @Valid request: AdminAccountActionRequest,
    ): AdminAccountDetailResponse =
        AdminAccountDetailResponse.from(service.suspend(admin.account, id, request.reason), admin.account.id)

    @PostMapping("/{id}/unsuspend")
    fun unsuspend(
        admin: AdminPrincipal,
        @PathVariable id: Long,
        @RequestBody @Valid request: AdminAccountActionRequest,
    ): AdminAccountDetailResponse =
        AdminAccountDetailResponse.from(service.unsuspend(admin.account, id, request.reason), admin.account.id)

    @PostMapping("/{id}/sessions/revoke")
    fun revokeSessions(
        admin: AdminPrincipal,
        @PathVariable id: Long,
        @RequestBody @Valid request: AdminAccountActionRequest,
    ): AdminAccountDetailResponse =
        AdminAccountDetailResponse.from(service.revokeSessions(admin.account, id, request.reason), admin.account.id)
}
