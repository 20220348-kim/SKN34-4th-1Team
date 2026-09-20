package ai.govbiz.core.admin.repository.mapper

import java.time.LocalDate
import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 관리자 계정 관리 SQL을 실행하는 MyBatis Mapper입니다. 삭제된 계정은 모든 조회에서 제외합니다. */
@Mapper
interface AdminAccountMapper {

    fun findAccounts(
        @Param("keywordPattern") keywordPattern: String?,
        @Param("businessNumberPattern") businessNumberPattern: String?,
        @Param("status") status: String?,
        @Param("role") role: String?,
        @Param("loginMethod") loginMethod: String?,
        @Param("sort") sort: String,
        @Param("limit") limit: Int,
        @Param("offset") offset: Int,
    ): List<AdminAccountDbRow>

    fun countAccounts(
        @Param("keywordPattern") keywordPattern: String?,
        @Param("businessNumberPattern") businessNumberPattern: String?,
        @Param("status") status: String?,
        @Param("role") role: String?,
        @Param("loginMethod") loginMethod: String?,
    ): Long

    fun findAccountById(@Param("id") id: Long): AdminAccountDbRow?

    fun findStats(@Param("joinedSince") joinedSince: LocalDateTime): AdminAccountStatsDbRow

    fun findCompanyByAccountId(@Param("accountId") accountId: Long): AdminAccountCompanyDbRow?

    fun countRecruitments(@Param("accountId") accountId: Long): Int

    fun countOpenRecruitments(
        @Param("accountId") accountId: Long,
        @Param("today") today: LocalDate,
    ): Int

    fun countSentProposals(@Param("accountId") accountId: Long): Int

    fun countActiveSessions(
        @Param("accountId") accountId: Long,
        @Param("now") now: LocalDateTime,
    ): Int

    fun findActions(
        @Param("accountId") accountId: Long,
        @Param("limit") limit: Int,
    ): List<AdminAccountActionDbRow>

    /** 조치 transaction 안에서 대상 계정 행을 `FOR UPDATE`로 잠가 읽습니다. */
    fun lockAccount(@Param("id") id: Long): AdminAccountTargetDbRow?

    fun updateSuspendedAt(
        @Param("accountId") accountId: Long,
        @Param("suspendedAt") suspendedAt: LocalDateTime?,
    ): Int

    fun insertAction(row: AdminAccountActionDbRow): Int
}
