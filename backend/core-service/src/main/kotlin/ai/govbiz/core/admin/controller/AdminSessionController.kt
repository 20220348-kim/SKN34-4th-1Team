package ai.govbiz.core.admin.controller

import ai.govbiz.core.admin.controller.dto.AdminSessionResponse
import ai.govbiz.core.admin.web.AdminPrincipal
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

/** Ops는 서명 키나 회원 DB를 공유하지 않고 기존 세션 Service를 거치는 resolver로 권한을 확인한다. */
@RestController
class AdminSessionController {
    @GetMapping("/api/v1/admin/session")
    fun session(admin: AdminPrincipal): ResponseEntity<AdminSessionResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
            AdminSessionResponse(admin.account.id, admin.account.email, admin.account.role),
        )
}
