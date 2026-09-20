package ai.govbiz.core.supportprogram.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 관심 공고함(`saved_support_program`) SQL을 실행하는 MyBatis Mapper입니다. 공고는 제공처 코드·원본 ID로 찾습니다. */
@Mapper
interface SavedSupportProgramMapper {

    /** 현재 노출 중인 공고일 때만 담습니다. 이미 담긴 공고는 무시하므로 0 또는 1을 돌려줍니다. */
    fun insertIfPresent(
        @Param("accountId") accountId: Long,
        @Param("sourceCode") sourceCode: String,
        @Param("sourceProgramId") sourceProgramId: String,
        @Param("savedAt") savedAt: LocalDateTime,
    ): Int

    fun deleteByIdentity(
        @Param("accountId") accountId: Long,
        @Param("sourceCode") sourceCode: String,
        @Param("sourceProgramId") sourceProgramId: String,
    ): Int

    fun findByIdentity(
        @Param("accountId") accountId: Long,
        @Param("sourceCode") sourceCode: String,
        @Param("sourceProgramId") sourceProgramId: String,
    ): SavedSupportProgramDbRow?

    /** 최근에 담은 순서입니다. 더 이상 노출되지 않는 공고는 빼고 읽습니다. */
    fun findByAccountId(@Param("accountId") accountId: Long): List<SavedSupportProgramDbRow>

    /** 원문 선수집 outbox: 발행 대기 행 id(오래된 순, 최대 20건)입니다. */
    fun findPublishablePrefetch(@Param("now") now: LocalDateTime): List<Long>

    fun reservePrefetchPublication(
        @Param("id") id: Long,
        @Param("now") now: LocalDateTime,
        @Param("retryAt") retryAt: LocalDateTime,
    ): Int

    fun markPrefetchPublished(@Param("id") id: Long, @Param("now") now: LocalDateTime): Int

    /** 발행 뒤 오래 소비되지 않은 행과 준비된 지 하루가 지난 행을 다시 대기로 돌립니다. */
    fun expirePublishedPrefetch(@Param("before") before: LocalDateTime): Int

    fun requeueStalePrefetch(@Param("before") before: LocalDateTime, @Param("limit") limit: Int): Int

    /** 큐에 실린(PUBLISHED) 행의 현재 공고입니다. 삭제됐거나 상태가 다르면 null입니다. */
    fun findPublishedProgram(@Param("id") id: Long): SavedSupportProgramDbRow?

    fun finishPrefetch(@Param("id") id: Long, @Param("status") status: String, @Param("now") now: LocalDateTime): Int
}
