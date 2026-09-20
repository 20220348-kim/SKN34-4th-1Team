package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 회원가입 인증번호 MySQL SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface SignupEmailVerificationMapper {
    fun insertVerification(row: SignupEmailVerificationDbRow): Int

    fun countSendsSince(
        @Param("email") email: String,
        @Param("since") since: LocalDateTime,
    ): Int

    fun findLatestCreatedAt(@Param("email") email: String): LocalDateTime?

    /** 아직 맞히지 않았고 만료되지 않은 가장 최근 인증번호입니다. */
    fun findLatestUnverifiedByEmail(
        @Param("email") email: String,
        @Param("now") now: LocalDateTime,
    ): SignupEmailVerificationDbRow?

    fun incrementAttempts(@Param("id") id: Long): Int

    fun markVerified(
        @Param("id") id: Long,
        @Param("passTokenHash") passTokenHash: String,
        @Param("verifiedAt") verifiedAt: LocalDateTime,
        @Param("passExpiresAt") passExpiresAt: LocalDateTime,
    ): Int

    /** 인증을 마쳤고 아직 가입에 쓰지 않았으며 만료되지 않은 통행 토큰의 행입니다. */
    fun findVerifiedPass(
        @Param("email") email: String,
        @Param("passTokenHash") passTokenHash: String,
        @Param("now") now: LocalDateTime,
    ): SignupEmailVerificationDbRow?

    fun markConsumed(
        @Param("id") id: Long,
        @Param("consumedAt") consumedAt: LocalDateTime,
    ): Int
}
