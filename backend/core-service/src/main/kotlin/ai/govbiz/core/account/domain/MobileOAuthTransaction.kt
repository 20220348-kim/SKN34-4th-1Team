package ai.govbiz.core.account.domain

import java.time.LocalDateTime

/** 앱 로그인 한 건과 앱에 전달할 코드가 묶인 값입니다. JWT·공급자 비밀값은 저장하지 않습니다. */
data class MobileOAuthTransaction(
    val stateHash: String,
    val provider: OAuthProvider,
    val redirectUri: String,
    val appState: String,
    val codeChallenge: String,
    val rememberMe: Boolean,
    val expiresAt: LocalDateTime,
    val accountId: Long? = null,
)
