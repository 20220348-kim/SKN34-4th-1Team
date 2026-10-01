package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper

@Mapper
interface ApplicationDocumentGenerationJobMapper {
    fun lockActiveAccount(ownerId: Long): Long?
    fun findRequest(ownerId: Long, requestKey: String): ApplicationDocumentGenerationJobDbRow?
    fun findActive(preparationId: Long): ApplicationDocumentGenerationJobDbRow?
    fun countPending(ownerId: Long): Int
    fun insert(row: ApplicationDocumentGenerationJobDbRow): Int
    fun find(id: Long): ApplicationDocumentGenerationJobDbRow?
    fun findOwned(ownerId: Long, preparationId: Long, id: Long): ApplicationDocumentGenerationJobDbRow?
    fun listOwned(ownerId: Long, preparationId: Long): List<ApplicationDocumentGenerationJobDbRow>
    fun listRecentOwned(ownerId: Long): List<ApplicationDocumentGenerationJobDbRow>
    fun markSeen(ownerId: Long, preparationId: Long, now: LocalDateTime): Int
    fun claimable(now: LocalDateTime, limit: Int): List<Long>
    fun claim(id: Long, now: LocalDateTime): Int
    fun updateStage(id: Long, stage: String, now: LocalDateTime): Int
    fun beginAi(id: Long, now: LocalDateTime): Int
    fun finish(id: Long, status: String, resultJson: String?, failureCode: String?, failureMessage: String?, failureDetailJson: String?, now: LocalDateTime): Int
    fun expireQueued(now: LocalDateTime): Int
    fun expireRunning(now: LocalDateTime): Int
    fun releaseUnknown(now: LocalDateTime, ttlSeconds: Long): Int
}
