package ai.govbiz.core.account.repository

import ai.govbiz.core.account.domain.SignupEmailVerification
import ai.govbiz.core.account.repository.mapper.SignupEmailVerificationDbRow
import ai.govbiz.core.account.repository.mapper.SignupEmailVerificationMapper
import java.time.LocalDateTime
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 회원가입 인증번호를 MySQL에 저장하고 읽습니다. 인증번호·통행 토큰 원문은 받지 않고 해시만 다룹니다. */
@Repository
class SignupEmailVerificationRepository(
    private val mapper: SignupEmailVerificationMapper,
) {

    @Transactional
    fun create(email: String, codeHash: String, expiresAt: LocalDateTime, createdAt: LocalDateTime): SignupEmailVerification {
        val row = SignupEmailVerificationDbRow(email = email, codeHash = codeHash, expiresAt = expiresAt, createdAt = createdAt)
        check(mapper.insertVerification(row) == 1) { "signup_email_verification row was not created" }
        return SignupEmailVerification(id = row.id, email = email, codeHash = codeHash, expiresAt = expiresAt, attemptCount = 0)
    }

    /** [since] 이후 이 이메일로 보낸 횟수입니다. 메일 폭주를 막는 한도 계산에 씁니다. */
    fun countSendsSince(email: String, since: LocalDateTime): Int = mapper.countSendsSince(email, since)

    /** 이 이메일로 마지막으로 보낸 시각입니다. 재전송 대기 시간 계산에 씁니다. */
    fun findLatestSentAt(email: String): LocalDateTime? = mapper.findLatestCreatedAt(email)

    /** 아직 맞히지 않았고 만료되지 않은 가장 최근 인증번호입니다. */
    fun findLatestUnverifiedByEmail(email: String, now: LocalDateTime): SignupEmailVerification? =
        mapper.findLatestUnverifiedByEmail(email, now)?.toDomain()

    @Transactional
    fun incrementAttempts(id: Long) {
        check(mapper.incrementAttempts(id) == 1) { "signup_email_verification row was not updated" }
    }

    @Transactional
    fun markVerified(id: Long, passTokenHash: String, verifiedAt: LocalDateTime, passExpiresAt: LocalDateTime) {
        check(mapper.markVerified(id, passTokenHash, verifiedAt, passExpiresAt) == 1) { "signup_email_verification row was not verified" }
    }

    /** 인증을 마쳤고 아직 가입에 쓰지 않았으며 만료되지 않은 통행 토큰이면 그 행의 id입니다. */
    fun findVerifiedPassId(email: String, passTokenHash: String, now: LocalDateTime): Long? =
        mapper.findVerifiedPass(email, passTokenHash, now)?.id

    @Transactional
    fun markConsumed(id: Long, consumedAt: LocalDateTime) {
        check(mapper.markConsumed(id, consumedAt) == 1) { "signup_email_verification row was not consumed" }
    }

    private fun SignupEmailVerificationDbRow.toDomain(): SignupEmailVerification =
        SignupEmailVerification(
            id = id,
            email = email,
            codeHash = codeHash,
            expiresAt = requireNotNull(expiresAt) { "expiresAt must not be null" },
            attemptCount = attemptCount,
        )
}
