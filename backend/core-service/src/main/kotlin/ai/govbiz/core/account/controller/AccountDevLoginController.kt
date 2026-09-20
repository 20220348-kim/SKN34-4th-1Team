package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.AuthSessionResponse
import ai.govbiz.core.account.controller.dto.DevLoginRequest
import ai.govbiz.core.account.service.AccountDevLoginService
import ai.govbiz.core.account.helper.SessionCookieHelper
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** `app.account.dev-login.enabled=true`일 때만 등록되는 개발용 시드 계정 로그인입니다. 꺼져 있으면 404입니다. */
@RestController
@RequestMapping("/api/v1/auth")
@ConditionalOnProperty(prefix = "app.account.dev-login", name = ["enabled"], havingValue = "true")
class AccountDevLoginController(
    private val devLoginService: AccountDevLoginService,
    private val cookieHelper: SessionCookieHelper,
) {

    /** 본문 없이 부르면 관리자, `{"role":"USER"}`면 기업 정보가 없는 회원 시드 계정입니다. */
    @PostMapping("/dev-login")
    fun logInAsSeedAccount(
        @RequestBody(required = false) request: DevLoginRequest?,
    ): ResponseEntity<AuthSessionResponse> {
        val result = devLoginService.logInAs((request ?: DevLoginRequest()).role)
        return ResponseEntity.ok()
            .header(HttpHeaders.SET_COOKIE, cookieHelper.issue(result.sessionToken, result.rememberMe).toString())
            .body(AuthSessionResponse.from(result))
    }
}
