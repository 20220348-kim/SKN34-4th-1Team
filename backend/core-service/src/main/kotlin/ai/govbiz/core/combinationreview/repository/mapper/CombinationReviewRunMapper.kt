package ai.govbiz.core.combinationreview.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface CombinationReviewRunMapper {
    fun lockActiveAccount(@Param("ownerId") ownerId: Long): Long?
    fun countAccountPending(@Param("ownerId") ownerId: Long): Int
    fun findById(@Param("runId") runId: Long): CombinationReviewRunDbRow?
    fun publishable(@Param("now") now: LocalDateTime): List<Long>
    fun reservePublication(@Param("runId") runId: Long, @Param("now") now: LocalDateTime): Int
    fun markPublished(@Param("runId") runId: Long, @Param("now") now: LocalDateTime): Int
    fun claim(@Param("runId") runId: Long, @Param("runnerId") runnerId: String, @Param("now") now: LocalDateTime): Int
    fun expireQueued(@Param("now") now: LocalDateTime): Int
    fun expireRunning(@Param("now") now: LocalDateTime): Int
    fun lockOwnedReview(@Param("ownerId") ownerId: Long, @Param("reviewId") reviewId: Long): Long?
    fun findRequest(@Param("reviewId") reviewId: Long, @Param("requestKey") requestKey: String): CombinationReviewRunDbRow?
    fun countRunning(@Param("reviewId") reviewId: Long): Int
    fun insertRun(row: CombinationReviewRunDbRow): Int
    fun findOwned(@Param("ownerId") ownerId: Long, @Param("reviewId") reviewId: Long, @Param("runId") runId: Long): CombinationReviewRunDbRow?
    fun listOwned(@Param("ownerId") ownerId: Long, @Param("reviewId") reviewId: Long, @Param("beforeId") beforeId: Long?, @Param("limit") limit: Int): List<CombinationReviewRunDbRow>
    fun saveEvidence(@Param("runId") runId: Long, @Param("evidenceJson") evidenceJson: String): Int
    fun insertSource(row: CombinationReviewRunSourceDbRow): Int
    fun findSource(@Param("ownerId") ownerId: Long, @Param("reviewId") reviewId: Long, @Param("runId") runId: Long, @Param("documentIndex") documentIndex: Int): CombinationReviewRunSourceDbRow?
    fun saveConfiguration(@Param("runId") runId: Long, @Param("configurationJson") configurationJson: String, @Param("now") now: LocalDateTime): Int
    fun finish(@Param("runId") runId: Long, @Param("status") status: String, @Param("analysisJson") analysisJson: String?, @Param("failureCode") failureCode: String?, @Param("finishedAt") finishedAt: LocalDateTime): Int
}
