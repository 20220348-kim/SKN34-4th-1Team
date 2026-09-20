package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface ApplicationPreparationInputMapper {
    fun lockOwnedRevision(@Param("ownerId") ownerId: Long, @Param("preparationId") preparationId: Long): Long?
    fun listOwnedFacts(@Param("ownerId") ownerId: Long, @Param("preparationId") preparationId: Long): List<ApplicationPreparationFactDbRow>
    fun listSectionFacts(@Param("preparationId") preparationId: Long, @Param("sectionKey") sectionKey: String): List<ApplicationPreparationFactDbRow>
    fun deleteSectionFacts(@Param("preparationId") preparationId: Long, @Param("sectionKey") sectionKey: String): Int
    fun insertFact(row: ApplicationPreparationFactDbRow): Int
    fun updatePreparationRevision(
        @Param("preparationId") preparationId: Long,
        @Param("expectedRevision") expectedRevision: Long,
        @Param("nextRevision") nextRevision: Long,
        @Param("updatedAt") updatedAt: LocalDateTime,
    ): Int
    fun findRequest(@Param("preparationId") preparationId: Long, @Param("requestKey") requestKey: String): ApplicationInterpretationRunDbRow?
    fun insertRun(row: ApplicationInterpretationRunDbRow): Int
    fun finishRun(
        @Param("runId") runId: Long,
        @Param("status") status: String,
        @Param("outputJson") outputJson: String?,
        @Param("failureCode") failureCode: String?,
        @Param("finishedAt") finishedAt: LocalDateTime,
    ): Int
}
