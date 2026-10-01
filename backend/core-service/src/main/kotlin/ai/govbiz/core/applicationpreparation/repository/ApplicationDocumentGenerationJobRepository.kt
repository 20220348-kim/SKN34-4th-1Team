package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationJob
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationJobStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationStage
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationDocumentGenerationJobDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationDocumentGenerationJobMapper
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

@Repository
class ApplicationDocumentGenerationJobRepository(
    private val mapper: ApplicationDocumentGenerationJobMapper,
    private val json: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    /** 같은 requestKey는 기존 작업을 돌려주고, 준비 건에 진행 중인 작업이 있으면 409, 계정당 3개를 넘으면 [capacity]가 true다. */
    class Reservation(val job: ApplicationDocumentGenerationJob?, val capacityExceeded: Boolean)

    @Transactional
    fun reserve(ownerId: Long, key: String, preparationId: Long, expectedRevision: Long): Reservation {
        mapper.lockActiveAccount(ownerId) ?: throw ApplicationPreparationNotFoundException()
        mapper.findRequest(ownerId, key)?.let {
            if (it.preparationId != preparationId || it.expectedRevision != expectedRevision) throw ApplicationPreparationRunConflictException()
            return Reservation(it.toDomain(), false)
        }
        if (mapper.findActive(preparationId) != null) throw ApplicationPreparationRunConflictException()
        if (mapper.countPending(ownerId) >= 3) return Reservation(null, true)
        val row = ApplicationDocumentGenerationJobDbRow(ownerAccountId = ownerId, preparationId = preparationId, requestKey = key,
            expectedRevision = expectedRevision, createdAt = now())
        check(mapper.insert(row) == 1 && row.id > 0)
        return Reservation(requireNotNull(mapper.find(row.id)).toDomain(), false)
    }

    fun findOwned(ownerId: Long, preparationId: Long, id: Long) = mapper.findOwned(ownerId, preparationId, id)?.toDomain()
    fun listOwned(ownerId: Long, preparationId: Long) = mapper.listOwned(ownerId, preparationId).map { it.toDomain() }
    fun listRecentOwned(ownerId: Long) = mapper.listRecentOwned(ownerId).map { it.toDomain() }
    fun markSeen(ownerId: Long, preparationId: Long) { mapper.markSeen(ownerId, preparationId, now()) }
    fun claimable(limit: Int): List<Long> = mapper.claimable(now(), limit)
    @Transactional
    fun claim(id: Long): ApplicationDocumentGenerationJob? =
        if (mapper.claim(id, now()) == 1) requireNotNull(mapper.find(id)).toDomain() else null

    fun updateStage(id: Long, stage: ApplicationDocumentGenerationStage): Boolean = mapper.updateStage(id, stage.name, now()) == 1
    fun beginAi(id: Long): Boolean = mapper.beginAi(id, now()) == 1
    fun succeed(id: Long, fileIds: List<Long>) {
        check(mapper.finish(id, "SUCCEEDED", json.writeValueAsString(fileIds), null, null, null, now()) == 1)
    }
    fun fail(id: Long, code: String, message: String, detail: Any? = null, unknown: Boolean = false) {
        mapper.finish(id, if (unknown) "UNKNOWN" else "FAILED", null, code.take(64), message.take(500),
            detail?.let { json.writeValueAsString(it) }, now())
    }
    /** 실패 상세(입력 위치 변경 안내)는 소유자의 작업 조회에서만 읽는다. */
    fun <T> failureDetail(ownerId: Long, preparationId: Long, id: Long, type: Class<T>): T? =
        mapper.findOwned(ownerId, preparationId, id)?.failureDetailJson?.let { json.readValue(it, type) }
    /** 결과 불명은 사람이 확인할 시간(동기 경로의 Redis 잠금과 같은 TTL)만 슬롯을 잡고, 그 뒤 실패로 내려 새 작업을 받는다. */
    @Transactional
    fun expireStaleWork(unknownOutcomeTtl: java.time.Duration) {
        mapper.expireQueued(now()); mapper.expireRunning(now()); mapper.releaseUnknown(now(), unknownOutcomeTtl.seconds)
    }
    private fun now() = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
    private fun ApplicationDocumentGenerationJobDbRow.toDomain() = ApplicationDocumentGenerationJob(
        id, ownerAccountId, preparationId, requestKey, expectedRevision,
        ApplicationDocumentGenerationJobStatus.valueOf(status), stage?.let(ApplicationDocumentGenerationStage::valueOf),
        resultJson?.let { json.readValue(it, LongArray::class.java).toList() }.orEmpty(),
        failureCode, failureMessage, requireNotNull(createdAt), finishedAt, seenAt,
    )
}
