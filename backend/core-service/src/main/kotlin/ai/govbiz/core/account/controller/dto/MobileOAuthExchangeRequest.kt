package ai.govbiz.core.account.controller.dto

import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

/** 일회용 코드·PKCE verifier는 요청 본문으로만 전달하고 toString에서는 숨깁니다. */
class MobileOAuthExchangeRequest(
    @field:Pattern(regexp = "[A-Za-z0-9_-]{43}")
    val code: String,
    @field:Pattern(regexp = "[A-Za-z0-9._~-]{43,128}")
    val codeVerifier: String,
    @field:Size(min = 1, max = 512)
    val redirectUri: String,
) {
    override fun toString(): String = "MobileOAuthExchangeRequest()"
}
