package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime

class MobileOAuthTransactionDbRow(
    var stateHash: String = "",
    var provider: String = "",
    var redirectUri: String = "",
    var appState: String = "",
    var codeChallenge: String = "",
    var rememberMe: Boolean = false,
    var expiresAt: LocalDateTime = LocalDateTime.MIN,
    var accountId: Long? = null,
)
