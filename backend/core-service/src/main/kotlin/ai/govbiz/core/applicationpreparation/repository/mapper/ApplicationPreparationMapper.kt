package ai.govbiz.core.applicationpreparation.repository.mapper

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface ApplicationPreparationMapper {
    fun insertPreparation(row: ApplicationPreparationDbRow): Int

    fun findOwned(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("preparationId") preparationId: Long,
    ): ApplicationPreparationDbRow?

    fun listOwned(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("beforeId") beforeId: Long?,
        @Param("limit") limit: Int,
    ): List<ApplicationPreparationDbRow>

    fun deleteOwned(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("preparationId") preparationId: Long,
    ): Int

    fun updateProgressOwned(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("preparationId") preparationId: Long,
        @Param("expectedProgressRevision") expectedProgressRevision: Long,
        @Param("progressStage") progressStage: String,
        @Param("updatedAt") updatedAt: java.time.LocalDateTime,
    ): Int
}
