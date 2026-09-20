package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryJob
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryJobStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryResult
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormDiscoveryJobDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormDiscoveryJobMapper
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException.Reason
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

@Repository
class ApplicationFormDiscoveryJobRepository(
    private val mapper: ApplicationFormDiscoveryJobMapper,
    private val json: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    @Transactional
    fun reserve(ownerId: Long, key: String, sourceCode: String, programId: String): ApplicationFormDiscoveryJob {
        mapper.lockActiveAccount(ownerId) ?: throw ApplicationFormDiscoveryException(Reason.JOB_NOT_FOUND)
        mapper.findRequest(ownerId, key)?.let {
            if (it.sourceCode != sourceCode || it.sourceProgramId != programId) throw ApplicationFormDiscoveryException(Reason.JOB_CONFLICT)
            return it.toDomain()
        }
        mapper.findActive(sourceCode, programId)?.let {
            // 다른 키/다른 계정에 기존 작업 ID 또는 결과를 노출하지 않는다.
            throw ApplicationFormDiscoveryException(Reason.JOB_CONFLICT)
        }
        if (mapper.countPending(ownerId) >= 3) throw ApplicationFormDiscoveryException(Reason.JOB_CAPACITY)
        val row = ApplicationFormDiscoveryJobDbRow(ownerAccountId = ownerId, requestKey = key,
            sourceCode = sourceCode, sourceProgramId = programId, createdAt = now())
        check(mapper.insert(row) == 1 && row.id > 0)
        return requireNotNull(mapper.find(row.id)).toDomain()
    }

    fun findOwned(ownerId: Long, id: Long) = mapper.findOwned(ownerId, id)?.toDomain()
    fun listOwned(ownerId: Long) = mapper.listOwned(ownerId).map { it.toDomain() }
    @Transactional
    fun claim(id: Long): ApplicationFormDiscoveryJob? =
        if (mapper.claim(id, now()) == 1) requireNotNull(mapper.find(id)).toDomain() else null

    fun beginAi(id: Long): Boolean = mapper.beginAi(id, now()) == 1
    fun succeed(id: Long, result: ApplicationFormDiscoveryResult) {
        check(mapper.finish(id, "SUCCEEDED", json.writeValueAsString(result), null, now()) == 1)
    }
    fun fail(id: Long, code: String, unknown: Boolean = false) {
        mapper.finish(id, if (unknown) "UNKNOWN" else "FAILED", null, code, now())
    }
    fun publishable() = mapper.publishable(now())
    fun reservePublication(id: Long) = mapper.reservePublication(id, now()) == 1
    fun markPublished(id: Long) { mapper.markPublished(id, now()) }
    @Transactional
    fun expireStaleWork() { mapper.expireQueued(now()); mapper.expireRunning(now()) }
    private fun now() = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
    private fun ApplicationFormDiscoveryJobDbRow.toDomain() = ApplicationFormDiscoveryJob(
        id, ownerAccountId, requestKey, sourceCode, sourceProgramId, programTitle, programSourceUrl,
        ApplicationFormDiscoveryJobStatus.valueOf(status),
        resultJson?.let { json.readValue(it, ApplicationFormDiscoveryResult::class.java) }, failureCode, requireNotNull(createdAt),
    )
}
