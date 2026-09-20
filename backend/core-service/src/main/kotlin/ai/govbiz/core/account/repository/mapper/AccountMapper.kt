package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 계정·로그인 세션 MySQL SQL을 실행하는 MyBatis Mapper입니다. 삭제된 계정은 모든 조회에서 제외합니다. */
@Mapper
interface AccountMapper {

    fun insertAccount(row: AccountDbRow): Int

    fun findAccountById(@Param("id") id: Long): AccountDbRow?

    fun findAccountByEmail(@Param("email") email: String): AccountDbRow?

    fun insertSession(row: AccountSessionDbRow): Int

    fun findSessionByTokenHash(@Param("tokenHash") tokenHash: String): AccountSessionDbRow?

    fun updateSessionLastUsedAt(
        @Param("tokenHash") tokenHash: String,
        @Param("lastUsedAt") lastUsedAt: LocalDateTime,
    ): Int

    fun deleteSessionByTokenHash(@Param("tokenHash") tokenHash: String): Int

    fun deleteExpiredSessionsByAccountId(
        @Param("accountId") accountId: Long,
        @Param("now") now: LocalDateTime,
    ): Int

    fun updateAccountPasswordHash(
        @Param("accountId") accountId: Long,
        @Param("passwordHash") passwordHash: String,
    ): Int

    fun updateAccountDeletedAt(
        @Param("accountId") accountId: Long,
        @Param("deletedAt") deletedAt: LocalDateTime,
        @Param("anonymizedEmail") anonymizedEmail: String,
    ): Int

    fun deleteSessionsByAccountIdExcept(
        @Param("accountId") accountId: Long,
        @Param("keepTokenHash") keepTokenHash: String,
    ): Int

    fun deleteSessionsByAccountId(@Param("accountId") accountId: Long): Int

    fun updateAccountLastLoginAt(
        @Param("accountId") accountId: Long,
        @Param("lastLoginAt") lastLoginAt: LocalDateTime,
    ): Int

    /** 삭제·정지되지 않은 관리자 수입니다. */
    fun countActiveAdmins(): Int
}
