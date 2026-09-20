package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper

@Mapper
interface ApplicationFormDiscoveryJobMapper {
    fun lockActiveAccount(ownerId: Long): Long?
    fun findRequest(ownerId: Long, requestKey: String): ApplicationFormDiscoveryJobDbRow?
    fun findActive(sourceCode: String, sourceProgramId: String): ApplicationFormDiscoveryJobDbRow?
    fun countPending(ownerId: Long): Int
    fun insert(row: ApplicationFormDiscoveryJobDbRow): Int
    fun find(id: Long): ApplicationFormDiscoveryJobDbRow?
    fun findOwned(ownerId: Long, id: Long): ApplicationFormDiscoveryJobDbRow?
    fun listOwned(ownerId: Long): List<ApplicationFormDiscoveryJobDbRow>
    fun claim(id: Long, now: LocalDateTime): Int
    fun beginAi(id: Long, now: LocalDateTime): Int
    fun finish(id: Long, status: String, resultJson: String?, failureCode: String?, now: LocalDateTime): Int
    fun publishable(now: LocalDateTime): List<Long>
    fun reservePublication(id: Long, now: LocalDateTime): Int
    fun markPublished(id: Long, now: LocalDateTime): Int
    fun expireQueued(now: LocalDateTime): Int
    fun expireRunning(now: LocalDateTime): Int
}
