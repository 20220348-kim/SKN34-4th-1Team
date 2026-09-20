package ai.govbiz.core.combinationreview.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface CombinationReviewMapper {
    fun insertReview(row: CombinationReviewDbRow): Int

    fun insertProgram(row: CombinationReviewProgramDbRow): Int

    fun findReview(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("reviewId") reviewId: Long,
    ): CombinationReviewDbRow?

    fun listReviews(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("beforeId") beforeId: Long?,
        @Param("limit") limit: Int,
    ): List<CombinationReviewDbRow>

    fun findPrograms(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("reviewId") reviewId: Long,
    ): List<CombinationReviewProgramDbRow>

    fun updateReviewIfRevisionMatches(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("reviewId") reviewId: Long,
        @Param("expectedRevision") expectedRevision: Long,
        @Param("title") title: String,
        @Param("updatedAt") updatedAt: LocalDateTime,
    ): Int

    fun deletePrograms(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("reviewId") reviewId: Long,
    ): Int

    fun deleteReview(
        @Param("ownerAccountId") ownerAccountId: Long,
        @Param("reviewId") reviewId: Long,
    ): Int
}
