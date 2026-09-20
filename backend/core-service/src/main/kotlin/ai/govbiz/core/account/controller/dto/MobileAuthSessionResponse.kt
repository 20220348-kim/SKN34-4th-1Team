package ai.govbiz.core.account.controller.dto

import ai.govbiz.core.account.service.dto.AccountSessionResult
import java.time.format.DateTimeFormatter

/** 네이티브 앱이 보안 저장소에 보관하는 세션입니다. 토큰을 toString·URL·쿠키에는 넣지 않습니다. */
class MobileAuthSessionResponse(
    val accessToken: String,
    val expiresAt: String,
    val account: AccountResponse,
) {
    val tokenType: String = "Bearer"

    override fun toString(): String = "MobileAuthSessionResponse(expiresAt=$expiresAt)"

    companion object {
        fun from(result: AccountSessionResult): MobileAuthSessionResponse =
            MobileAuthSessionResponse(
                accessToken = result.sessionToken,
                expiresAt = result.expiresAt.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                account = AccountResponse.from(result.account),
            )
    }
}
