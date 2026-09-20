package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime

/** MyBatis가 소셜 로그인 연결 한 행을 읽고 쓰기 위한 DB 행 값입니다. [provider]는 enum 이름(`KAKAO`·`GOOGLE`)입니다. */
data class AccountOAuthIdentityDbRow(
    var id: Long = 0,
    var accountId: Long = 0,
    var provider: String = "",
    var subject: String = "",
    var linkedAt: LocalDateTime? = null,
)
