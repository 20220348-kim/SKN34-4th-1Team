package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 비밀번호 재설정 토큰 MySQL SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface AccountPasswordResetMapper {
    fun insertReset(row: AccountPasswordResetDbRow): Int

    fun countResetsSince(
        @Param("accountId") accountId: Long,
        @Param("since") since: LocalDateTime,
    ): Int

    /** 아직 쓰지 않았고 만료되지 않은 토큰만 찾습니다. */
    fun findActiveResetByTokenHash(
        @Param("tokenHash") tokenHash: String,
        @Param("now") now: LocalDateTime,
    ): AccountPasswordResetDbRow?

    fun deleteResetsByAccountId(@Param("accountId") accountId: Long): Int
}
