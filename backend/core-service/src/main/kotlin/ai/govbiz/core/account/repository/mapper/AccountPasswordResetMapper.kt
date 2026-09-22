package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 비밀번호 재설정 인증번호 MySQL SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface AccountPasswordResetMapper {
    fun insertReset(row: AccountPasswordResetDbRow): Int

    fun countResetsSince(
        @Param("accountId") accountId: Long,
        @Param("since") since: LocalDateTime,
    ): Int

    fun findLatestCreatedAt(@Param("accountId") accountId: Long): LocalDateTime?

    /** 아직 맞히지 않았고 만료되지 않은 가장 최근 인증번호입니다. */
    fun findLatestUnverifiedByAccountId(
        @Param("accountId") accountId: Long,
        @Param("now") now: LocalDateTime,
    ): AccountPasswordResetDbRow?

    fun incrementAttempts(@Param("id") id: Long): Int

    fun markVerified(
        @Param("id") id: Long,
        @Param("passTokenHash") passTokenHash: String,
        @Param("verifiedAt") verifiedAt: LocalDateTime,
        @Param("passExpiresAt") passExpiresAt: LocalDateTime,
    ): Int

    /** 인증을 마쳤고 아직 쓰지 않았으며 만료되지 않은 통행 토큰의 행입니다. */
    fun findVerifiedPass(
        @Param("passTokenHash") passTokenHash: String,
        @Param("now") now: LocalDateTime,
    ): AccountPasswordResetDbRow?

    fun deleteResetsByAccountId(@Param("accountId") accountId: Long): Int
}
