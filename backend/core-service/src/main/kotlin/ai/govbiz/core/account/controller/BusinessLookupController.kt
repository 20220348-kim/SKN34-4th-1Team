package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.BusinessLookupResponse
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.service.BusinessLookupService
import jakarta.validation.constraints.Pattern
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** 로그인한 회원의 사업자등록번호 확인입니다. [Account] 파라미터는 세션 쿠키로 채워지며 없으면 401입니다. */
@RestController
@RequestMapping("/api/v1/me/company")
class BusinessLookupController(
    private val lookupService: BusinessLookupService,
) {

    /** 기업 등록 전에 사업자등록번호(하이픈 선택)로 상호와 사업자 상태를 미리 봅니다. */
    @GetMapping("/lookup")
    fun lookup(
        account: Account,
        @RequestParam
        @Pattern(regexp = "[0-9]{3}-?[0-9]{2}-?[0-9]{5}")
        businessNumber: String,
    ): BusinessLookupResponse =
        BusinessLookupResponse.from(lookupService.lookup(businessNumber))
}
