package ai.govbiz.core.admin.controller.dto

import ai.govbiz.core.account.domain.AccountRole

/** 이메일 재사용·변경에도 Ops 실행 요청자의 식별자가 바뀌지 않도록 회원 ID를 제공한다. */
data class AdminSessionResponse(val accountId: Long, val email: String, val role: AccountRole)
