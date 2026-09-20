package ai.govbiz.core.account.repository

import ai.govbiz.core.account.domain.PasswordReset
import ai.govbiz.core.account.repository.mapper.AccountPasswordResetDbRow
import ai.govbiz.core.account.repository.mapper.AccountPasswordResetMapper
import java.time.LocalDateTime
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 비밀번호 재설정 토큰을 MySQL에 저장하고 읽습니다. 토큰 원문은 받지 않고 해시만 다룹니다. */
@Repository
class AccountPasswordResetRepository(
    private val mapper: AccountPasswordResetMapper,
) {

    @Transactional
    fun create(accountId: Long, tokenHash: String, expiresAt: LocalDateTime, createdAt: LocalDateTime): PasswordReset {
        val row = AccountPasswordResetDbRow(accountId = accountId, tokenHash = tokenHash, expiresAt = expiresAt, createdAt = createdAt)
        check(mapper.insertReset(row) == 1) { "account_password_reset row was not created" }
        return PasswordReset(id = row.id, accountId = accountId, expiresAt = expiresAt)
    }

    /** [since] 이후 이 계정이 요청한 횟수입니다. 메일 폭주를 막는 한도 계산에 씁니다. */
    fun countRequestsSince(accountId: Long, since: LocalDateTime): Int = mapper.countResetsSince(accountId, since)

    /** 아직 쓰지 않았고 만료되지 않은 토큰만 돌려줍니다. */
    fun findActiveByTokenHash(tokenHash: String, now: LocalDateTime): PasswordReset? =
        mapper.findActiveResetByTokenHash(tokenHash, now)?.let {
            PasswordReset(id = it.id, accountId = it.accountId, expiresAt = requireNotNull(it.expiresAt) { "expiresAt must not be null" })
        }

    /** 비밀번호를 바꾼 뒤 같은 계정의 남은 토큰을 전부 없앱니다. */
    @Transactional
    fun deleteAllByAccountId(accountId: Long): Int = mapper.deleteResetsByAccountId(accountId)
}
