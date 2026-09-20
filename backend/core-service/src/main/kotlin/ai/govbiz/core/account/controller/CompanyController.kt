package ai.govbiz.core.account.controller

import ai.govbiz.core.account.controller.dto.CompanyPartnerProfileRequest
import ai.govbiz.core.account.controller.dto.CompanyPartnerProfileResponse
import ai.govbiz.core.account.controller.dto.CompanyProfileRequest
import ai.govbiz.core.account.controller.dto.CompanyResponse
import ai.govbiz.core.account.controller.dto.RegisterCompanyRequest
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.service.CompanyService
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 로그인한 회원의 기업입니다. 사업자등록번호 미리보기는 [BusinessLookupController]가 맡습니다. [Account]는 세션 쿠키로 채워지며 없으면 401입니다. */
@RestController
@RequestMapping("/api/v1/me/company")
class CompanyController(
    private val companyService: CompanyService,
) {

    @GetMapping
    fun mine(account: Account): CompanyResponse =
        CompanyResponse.from(companyService.findMine(account))

    @PostMapping
    fun register(
        account: Account,
        @RequestBody @Valid request: RegisterCompanyRequest,
    ): ResponseEntity<CompanyResponse> {
        val company = companyService.register(account, request.businessNumber, request.toProfileInput())
        return ResponseEntity.status(HttpStatus.CREATED).body(CompanyResponse.from(company))
    }

    @PutMapping
    fun update(
        account: Account,
        @RequestBody @Valid request: CompanyProfileRequest,
    ): CompanyResponse =
        CompanyResponse.from(companyService.updateProfile(account, request.toProfileInput()))

    /** 협업·파트너 설정입니다. 저장한 적이 없으면 `isSet=false`와 기본값입니다. */
    @GetMapping("/partner-profile")
    fun partnerProfile(account: Account): CompanyPartnerProfileResponse =
        CompanyPartnerProfileResponse.from(companyService.findPartnerProfile(account))

    @PutMapping("/partner-profile")
    fun updatePartnerProfile(
        account: Account,
        @RequestBody @Valid request: CompanyPartnerProfileRequest,
    ): CompanyPartnerProfileResponse =
        CompanyPartnerProfileResponse.from(companyService.updatePartnerProfile(account, request.toInput()))
}
