package ai.govbiz.core.supportprogram.repository.mapper

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** Catalog projection의 수신 checkpoint와 공개 상태를 저장합니다. */
@Mapper
interface CatalogProjectionMapper {
    fun countCheckpoints(): Long

    fun countDistinctProgramIds(@Param("programIdsJson") programIdsJson: String): Int

    fun insertCheckpointIfAbsent(row: CatalogProjectionCheckpointDbRow): Int

    fun lockCheckpoint(@Param("sourceCode") sourceCode: String): CatalogProjectionCheckpointDbRow?

    fun updateCheckpoint(row: CatalogProjectionCheckpointDbRow): Int

    fun upsertSyncStatus(row: SupportProgramSyncStatusDbRow): Int
}
