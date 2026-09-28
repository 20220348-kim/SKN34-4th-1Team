package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.AccountDeletionPreviewResponse
import ai.govbiz.core.account.controller.dto.ChangePasswordRequest
import ai.govbiz.core.account.controller.dto.CompleteOnboardingRequest
import ai.govbiz.core.account.controller.dto.CurrentAccountResponse
import ai.govbiz.core.account.controller.dto.DeleteAccountRequest
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SessionRequestTokenHelper
import ai.govbiz.core.account.service.AccountOnboardingService
import ai.govbiz.core.account.service.AccountProfileService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 로그인한 회원 본인의 계정 관리입니다. 쿠키/Bearer 세션을 확인한 [Account]는 resolver가 채웁니다. */
@RestController
@RequestMapping("/api/v1/me")
class AccountProfileController(
    private val profileService: AccountProfileService,
    private val cookieHelper: SessionCookieHelper,
    private val onboardingService: AccountOnboardingService,
) {

    /** 로그인한 세션으로 본인을 확인하고 바꾸며, 지금 쓰는 세션만 남기고 다른 기기의 세션은 끝냅니다. */
    /** 환영 화면의 답을 저장하고 갱신된 계정을 돌려줍니다. 프로필에서 유형을 바꿀 때도 같은 API를 씁니다. */
    @PutMapping("/onboarding")
    fun completeOnboarding(
        account: Account,
        @RequestBody @Valid request: CompleteOnboardingRequest,
    ): CurrentAccountResponse =
        CurrentAccountResponse.from(onboardingService.complete(account, requireNotNull(request.accountType)))

    @PutMapping("/password")
    fun changePassword(
        account: Account,
        @RequestBody @Valid request: ChangePasswordRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<Void> {
        profileService.changePassword(account, request.newPassword, SessionRequestTokenHelper.read(httpRequest))
        return ResponseEntity.noContent().build()
    }

    /** 삭제 확인 화면에 보여 줄 수치입니다. 삭제하지 않습니다. */
    @GetMapping("/deletion-preview")
    fun previewDeletion(account: Account): AccountDeletionPreviewResponse =
        AccountDeletionPreviewResponse.from(profileService.previewDeletion(account))

    /** 현재 비밀번호를 확인한 뒤(비밀번호가 없는 소셜 가입 계정은 세션만으로) 계정을 삭제 표시하고 세션 쿠키를 만료시킵니다. */
    @DeleteMapping
    fun deleteAccount(
        account: Account,
        @RequestBody @Valid request: DeleteAccountRequest,
    ): ResponseEntity<Void> {
        profileService.deleteAccount(account, request.password)
        return ResponseEntity.noContent()
            .header(HttpHeaders.SET_COOKIE, cookieHelper.expire().toString())
            .build()
    }
}
