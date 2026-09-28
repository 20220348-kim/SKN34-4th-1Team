package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.domain.AccountType
import jakarta.validation.constraints.NotNull

/** 환영 화면의 답입니다. 회원 유형 하나만 받으며 필수입니다. */
data class CompleteOnboardingRequest(
    @field:NotNull
    val accountType: AccountType?,
)
