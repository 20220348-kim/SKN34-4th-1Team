package ai.govbiz.core.partner.repository.mapper

import java.time.LocalDate
import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 파트너 모집글 MySQL SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface PartnerRecruitmentMapper {

    fun findPresentProgram(
        @Param("sourceCode") sourceCode: String,
        @Param("sourceProgramId") sourceProgramId: String,
    ): PartnerProgramDbRow?

    fun insertRecruitment(row: PartnerRecruitmentDbRow): Int

    fun findRecruitmentById(@Param("id") id: Long): PartnerRecruitmentDbRow?

    /** [row]의 id로 내용 열과 updated_at만 바꿉니다. 마감된 행은 건너뛰므로 0을 돌려줄 수 있습니다. */
    fun updateRecruitment(row: PartnerRecruitmentDbRow): Int

    fun closeRecruitment(
        @Param("id") id: Long,
        @Param("closedAt") closedAt: LocalDateTime,
    ): Int

    /**
     * [keywordPattern]은 LIKE 패턴으로 이미 이스케이프된 값이며 비어 있으면 검색어 조건을 두지 않습니다.
     * [seekingRoles]·[regions]는 IN 목록이며 null이면 조건을 두지 않습니다. [regions]에는 Repository가 전국을 더해 줍니다.
     */
    fun findRecruitments(
        @Param("keywordPattern") keywordPattern: String?,
        @Param("seekingRoles") seekingRoles: List<String>?,
        @Param("regions") regions: List<String>?,
        @Param("mineAccountId") mineAccountId: Long?,
        @Param("sourceCode") sourceCode: String?,
        @Param("today") today: LocalDate,
        @Param("sortByRecent") sortByRecent: Boolean,
        @Param("limit") limit: Int,
        @Param("offset") offset: Int,
    ): List<PartnerRecruitmentDbRow>

    fun countRecruitments(
        @Param("keywordPattern") keywordPattern: String?,
        @Param("seekingRoles") seekingRoles: List<String>?,
        @Param("regions") regions: List<String>?,
        @Param("mineAccountId") mineAccountId: Long?,
        @Param("sourceCode") sourceCode: String?,
        @Param("today") today: LocalDate,
    ): Long

    fun countOpenRecruitmentsByAccount(@Param("accountId") accountId: Long): Int

    fun closeRecruitmentsByAccount(
        @Param("accountId") accountId: Long,
        @Param("closedAt") closedAt: LocalDateTime,
    ): Int
}
