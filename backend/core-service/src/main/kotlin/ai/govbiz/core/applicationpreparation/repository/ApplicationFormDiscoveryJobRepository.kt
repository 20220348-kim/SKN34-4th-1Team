package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryJob
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryJobStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryResult
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormDiscoveryJobDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormDiscoveryJobMapper
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException.Reason
import java.time.Clock
import java.time.Duration
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

@Repository
class ApplicationFormDiscoveryJobRepository(
    private val mapper: ApplicationFormDiscoveryJobMapper,
    private val json: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
    /** 결과 불명(UNKNOWN) 작업이 계정 한도를 잡아 두는 최대 시간. RUNNING 20분 만료보다 길어야 늦은 완료가 먼저 판정된다. */
    @param:Value("\${app.application-form-discovery.unknown-ttl:PT30M}") private val unknownTtl: Duration,
) {
    init {
        require(unknownTtl >= Duration.ofMinutes(20)) { "app.application-form-discovery.unknown-ttl must be at least PT20M" }
    }
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
    /**
     * 만료 정리. QUEUED 1시간·계정 비활성 → FAILED, RUNNING 20분 → UNKNOWN. UNKNOWN은 같은 공고의 가용성이 AI 시작 이후 확정됐으면
     * 바로, 아니면 TTL이 지나면 FAILED로 닫아 계정 한도(활성 3건)를 돌려준다. 어느 경우에도 AI를 다시 부르지 않는다.
     */
    @Transactional
    fun expireStaleWork() {
        val now = now()
        mapper.expireQueued(now); mapper.expireRunning(now)
        mapper.settleUnknown(now); mapper.releaseUnknown(now, unknownTtl.seconds)
    }
    private fun now() = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
    private fun ApplicationFormDiscoveryJobDbRow.toDomain() = ApplicationFormDiscoveryJob(
        id, ownerAccountId, requestKey, sourceCode, sourceProgramId, programTitle, programSourceUrl,
        ApplicationFormDiscoveryJobStatus.valueOf(status),
        resultJson?.let { json.readValue(it, ApplicationFormDiscoveryResult::class.java) }, failureCode, requireNotNull(createdAt),
    )
}
