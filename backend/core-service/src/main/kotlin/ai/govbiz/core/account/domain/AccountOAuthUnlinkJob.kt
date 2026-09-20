package ai.govbiz.core.account.domain

/** 외부 연결 해제에 필요한 최소 식별자. 토큰·이메일·어드민 키는 저장하지 않는다. */
data class AccountOAuthUnlinkJob(val id: Long, val accountId: Long, val subject: String)
