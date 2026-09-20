package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface ApplicationPreparationContentMapper {
    fun listOwned(@Param("ownerId") ownerId: Long, @Param("preparationId") preparationId: Long): List<ApplicationPreparationContentDbRow>
    fun latest(@Param("preparationId") preparationId: Long, @Param("sectionKey") sectionKey: String): ApplicationPreparationContentDbRow?
    fun insertVersion(row: ApplicationPreparationContentDbRow): Int
    fun confirm(@Param("id") id: Long, @Param("confirmedAt") confirmedAt: LocalDateTime): Int
    fun findRequest(@Param("preparationId") preparationId: Long, @Param("requestKey") requestKey: String): ApplicationPreparationDraftRunDbRow?
    fun insertRun(row: ApplicationPreparationDraftRunDbRow): Int
    fun hasRunning(@Param("preparationId") preparationId: Long, @Param("sectionKey") sectionKey: String): Boolean
    fun finishRun(@Param("id") id: Long, @Param("status") status: String, @Param("outputJson") outputJson: String?, @Param("applied") applied: Boolean, @Param("finishedAt") finishedAt: LocalDateTime): Int
    fun touch(@Param("preparationId") preparationId: Long, @Param("updatedAt") updatedAt: LocalDateTime): Int
}
