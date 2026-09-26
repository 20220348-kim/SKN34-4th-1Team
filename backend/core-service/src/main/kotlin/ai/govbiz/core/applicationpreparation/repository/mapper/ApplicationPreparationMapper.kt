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

    fun findOwnedForUpdate(@Param("ownerAccountId") ownerAccountId: Long,
        @Param("preparationId") preparationId: Long): ApplicationPreparationDbRow?

    fun updateFormVersionOwned(@Param("ownerAccountId") ownerAccountId: Long,
        @Param("preparationId") preparationId: Long,
        @Param("oldFormVersionId") oldFormVersionId: String,
        @Param("newFormVersionId") newFormVersionId: String,
        @Param("expectedRevision") expectedRevision: Long): Int

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
