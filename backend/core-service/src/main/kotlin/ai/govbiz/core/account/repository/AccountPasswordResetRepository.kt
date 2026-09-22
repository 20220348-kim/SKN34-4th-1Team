package ai.govbiz.core.account.repository

import ai.govbiz.core.account.domain.PasswordReset
import ai.govbiz.core.account.repository.mapper.AccountPasswordResetDbRow
import ai.govbiz.core.account.repository.mapper.AccountPasswordResetMapper
import java.time.LocalDateTime
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 비밀번호 재설정 인증번호를 MySQL에 저장하고 읽습니다. 인증번호·통행 토큰 원문은 받지 않고 해시만 다룹니다. */
@Repository
class AccountPasswordResetRepository(
    private val mapper: AccountPasswordResetMapper,
) {

    @Transactional
    fun create(accountId: Long, codeHash: String, expiresAt: LocalDateTime, createdAt: LocalDateTime): PasswordReset {
        val row = AccountPasswordResetDbRow(accountId = accountId, codeHash = codeHash, expiresAt = expiresAt, createdAt = createdAt)
        check(mapper.insertReset(row) == 1) { "account_password_reset row was not created" }
        return PasswordReset(id = row.id, accountId = accountId, codeHash = codeHash, expiresAt = expiresAt, attemptCount = 0)
    }

    /** [since] 이후 이 계정이 요청한 횟수입니다. 메일 폭주를 막는 한도 계산에 씁니다. */
    fun countRequestsSince(accountId: Long, since: LocalDateTime): Int = mapper.countResetsSince(accountId, since)

    /** 이 계정으로 마지막으로 보낸 시각입니다. 재전송 대기 시간 계산에 씁니다. */
    fun findLatestSentAt(accountId: Long): LocalDateTime? = mapper.findLatestCreatedAt(accountId)

    /** 아직 맞히지 않았고 만료되지 않은 가장 최근 인증번호입니다. */
    fun findLatestUnverifiedByAccountId(accountId: Long, now: LocalDateTime): PasswordReset? =
        mapper.findLatestUnverifiedByAccountId(accountId, now)?.toDomain()

    @Transactional
    fun incrementAttempts(id: Long) {
        check(mapper.incrementAttempts(id) == 1) { "account_password_reset row was not updated" }
    }

    @Transactional
    fun markVerified(id: Long, passTokenHash: String, verifiedAt: LocalDateTime, passExpiresAt: LocalDateTime) {
        check(mapper.markVerified(id, passTokenHash, verifiedAt, passExpiresAt) == 1) { "account_password_reset row was not verified" }
    }

    /** 재설정 Service transaction에서 유효한 통행 토큰 행을 잠가 동시 재사용을 막습니다. */
    fun findVerifiedPass(passTokenHash: String, now: LocalDateTime): PasswordReset? =
        mapper.findVerifiedPass(passTokenHash, now)?.toDomain()

    /** 비밀번호를 바꾼 뒤 같은 계정의 남은 인증번호·통행 토큰을 전부 없앱니다. */
    @Transactional
    fun deleteAllByAccountId(accountId: Long): Int = mapper.deleteResetsByAccountId(accountId)

    private fun AccountPasswordResetDbRow.toDomain(): PasswordReset =
        PasswordReset(
            id = id,
            accountId = accountId,
            codeHash = codeHash,
            expiresAt = requireNotNull(expiresAt) { "expiresAt must not be null" },
            attemptCount = attemptCount,
        )
}
