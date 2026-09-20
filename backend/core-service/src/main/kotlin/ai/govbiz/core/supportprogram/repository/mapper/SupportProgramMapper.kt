package ai.govbiz.core.supportprogram.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 지원사업 카탈로그 MySQL SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface SupportProgramMapper {

    fun upsert(row: SupportProgramDbRow): Int

    fun upsertBatch(@Param("rows") rows: List<SupportProgramDbRow>): Int

    fun markAllNotPresentBySourceCode(@Param("sourceCode") sourceCode: String): Int

    fun findBySourceAndProgramId(
        @Param("sourceCode") sourceCode: String,
        @Param("sourceProgramId") sourceProgramId: String,
    ): SupportProgramDbRow?

    fun findPresent(): List<SupportProgramDbRow>

    fun findPublishedPresent(@Param("requireIndexReady") requireIndexReady: Boolean): List<SupportProgramDbRow>

    fun upsertSourceDocument(row: SupportProgramSourceDocumentDbRow): Int

    fun findPresentSourceDocument(
        @Param("sourceCode") sourceCode: String,
        @Param("sourceProgramId") sourceProgramId: String,
    ): SupportProgramSourceDocumentDbRow?

    fun insertSyncGenerationIfAbsent(@Param("sourceCode") sourceCode: String): Int

    fun lockLatestStartedGeneration(@Param("sourceCode") sourceCode: String): Long?

    fun updateLatestStartedGeneration(
        @Param("sourceCode") sourceCode: String,
        @Param("generation") generation: Long,
    ): Int

    fun findSyncStatus(@Param("sourceCode") sourceCode: String): SupportProgramSyncStatusDbRow?

    fun findSyncStatuses(): List<SupportProgramSyncStatusDbRow>

    fun upsertSyncSuccess(
        @Param("sourceCode") sourceCode: String,
        @Param("generation") generation: Long,
        @Param("catalogFingerprint") catalogFingerprint: String,
        @Param("programCount") programCount: Int,
        @Param("occurredAt") occurredAt: LocalDateTime,
    ): Int

    fun upsertSyncFailure(
        @Param("sourceCode") sourceCode: String,
        @Param("occurredAt") occurredAt: LocalDateTime,
    ): Int

    fun markSyncIndexReady(
        @Param("sourceCode") sourceCode: String,
        @Param("publishedGeneration") publishedGeneration: Long,
        @Param("catalogFingerprint") catalogFingerprint: String,
        @Param("programCount") programCount: Int,
    ): Int

    fun markSyncIndexNotReady(
        @Param("sourceCode") sourceCode: String,
        @Param("publishedGeneration") publishedGeneration: Long,
        @Param("catalogFingerprint") catalogFingerprint: String,
        @Param("programCount") programCount: Int,
    ): Int

    fun insertSyncStatusIfAbsent(@Param("sourceCode") sourceCode: String): Int

    fun bootstrapSyncStatusIfUntrusted(
        @Param("sourceCode") sourceCode: String,
        @Param("catalogFingerprint") catalogFingerprint: String,
        @Param("programCount") programCount: Int,
    ): Int
}
