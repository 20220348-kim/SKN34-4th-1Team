package ai.govbiz.core.combinationreview.repository

import ai.govbiz.core.combinationreview.domain.*
import ai.govbiz.core.combinationreview.helper.CombinationReviewHashHelper
import ai.govbiz.core.combinationreview.repository.mapper.CombinationReviewRunDbRow
import ai.govbiz.core.combinationreview.repository.mapper.CombinationReviewRunMapper
import ai.govbiz.core.combinationreview.repository.mapper.CombinationReviewRunSourceDbRow
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewNotFoundException
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewRevisionConflictException
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewRunConflictException
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewCapacityException
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Isolation
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

/** 각 짧은 DB transaction만 소유한다. 수집·LLM 호출은 이 Repository 밖에서 수행한다. */
@Repository
class CombinationReviewRunRepository(
    private val mapper: CombinationReviewRunMapper, private val reviews: CombinationReviewRepository,
    private val json: ObjectMapper, @param:Qualifier("seoulClock") private val clock: Clock,
) {
    @Transactional(isolation = Isolation.REPEATABLE_READ)
    fun reserve(ownerId: Long, reviewId: Long, expectedRevision: Long, requestKey: String, additionalFacts: String, runnerInstanceId: String): ReviewRunReservation {
        mapper.lockActiveAccount(ownerId) ?: throw CombinationReviewNotFoundException()
        val revision = mapper.lockOwnedReview(ownerId, reviewId) ?: throw CombinationReviewNotFoundException()
        val hash = CombinationReviewHashHelper.sha256("$expectedRevision\n$additionalFacts")
        mapper.findRequest(reviewId, requestKey)?.let {
            if (it.requestHash != hash) throw CombinationReviewRunConflictException()
            return ReviewRunReservation(it.toDomain(), false)
        }
        if (revision != expectedRevision) throw CombinationReviewRevisionConflictException()
        if (mapper.countRunning(reviewId) != 0) throw CombinationReviewRunConflictException()
        if (mapper.countAccountPending(ownerId) >= 3) {
            throw CombinationReviewCapacityException()
        }
        val review = requireNotNull(reviews.findOwned(ownerId, reviewId))
        val row = CombinationReviewRunDbRow(
            reviewId = reviewId, inputRevision = revision, requestKey = requestKey, requestHash = hash,
            inputJson = json.writeValueAsString(ReviewRunSnapshot(review.draft.title, review.draft.input.programs, additionalFacts, LocalDate.now(clock))),
            runnerInstanceId = runnerInstanceId, startedAt = now(),
        )
        check(mapper.insertRun(row) == 1 && row.id > 0)
        return ReviewRunReservation(row.toDomain(), true)
    }

    fun replay(ownerId: Long, reviewId: Long, expectedRevision: Long, requestKey: String, additionalFacts: String): ReviewRunReservation? {
        reviews.findOwned(ownerId, reviewId) ?: throw CombinationReviewNotFoundException()
        val row = mapper.findRequest(reviewId, requestKey) ?: return null
        if (row.requestHash != CombinationReviewHashHelper.sha256("$expectedRevision\n$additionalFacts")) throw CombinationReviewRunConflictException()
        return ReviewRunReservation(row.toDomain(), false)
    }

    /** QUEUED에서 한 번만 실행권을 얻는다. RUNNING/UNKNOWN 재전달은 절대 재실행하지 않는다. */
    @Transactional
    fun claim(runId: Long, runnerId: String): StoredCombinationReviewRun? {
        if (mapper.claim(runId, runnerId, now()) != 1) return null
        return requireNotNull(mapper.findById(runId)).toDomain()
    }

    fun publishable(): List<Long> = mapper.publishable(now())
    fun reservePublication(runId: Long): Boolean = mapper.reservePublication(runId, now()) == 1
    fun markPublished(runId: Long) { mapper.markPublished(runId, now()) }

    @Transactional
    fun expireStaleWork() {
        val now = now()
        mapper.expireQueued(now)
        mapper.expireRunning(now)
    }

    fun findOwned(ownerId: Long, reviewId: Long, runId: Long): StoredCombinationReviewRun? = mapper.findOwned(ownerId, reviewId, runId)?.toDomain()
    fun listOwned(ownerId: Long, reviewId: Long, beforeId: Long?, limit: Int): List<ReviewRunSummary> {
        require(limit in 1..51)
        return mapper.listOwned(ownerId, reviewId, beforeId, limit).map {
            ReviewRunSummary(it.id, it.inputRevision, ReviewRunStatus.valueOf(it.status), it.failureCode, requireNotNull(it.startedAt), it.finishedAt)
        }
    }

    @Transactional
    fun saveEvidence(runId: Long, evidence: ReviewEvidenceSnapshot, sourceBytes: List<ByteArray>) {
        require(evidence.documents.size == sourceBytes.size && sourceBytes.size in 1..12)
        check(mapper.saveEvidence(runId, json.writeValueAsString(evidence)) == 1)
        evidence.documents.forEachIndexed { index, document ->
            require(document.rawHash == CombinationReviewHashHelper.sha256(sourceBytes[index]))
            check(mapper.insertSource(CombinationReviewRunSourceDbRow(runId, index, document.rawHash, sourceBytes[index])) == 1)
        }
    }

    fun findSource(ownerId: Long, reviewId: Long, runId: Long, documentIndex: Int): ByteArray? =
        mapper.findSource(ownerId, reviewId, runId, documentIndex)?.let {
            check(CombinationReviewHashHelper.sha256(it.rawBytes) == it.rawHash) { "stored source integrity error" }
            it.rawBytes
        }

    @Transactional
    fun saveConfiguration(runId: Long, configuration: ReviewModelConfiguration) {
        check(mapper.saveConfiguration(runId, json.writeValueAsString(configuration), now()) == 1)
    }

    @Transactional
    fun succeed(runId: Long, analysis: ReviewAnalysis): LocalDateTime {
        val finishedAt = now()
        check(mapper.finish(runId, "SUCCEEDED", json.writeValueAsString(analysis), null, finishedAt) == 1)
        return finishedAt
    }

    @Transactional
    fun fail(runId: Long, code: String) {
        mapper.finish(runId, "FAILED", null, code, now())
    }

    fun markUnknown(runId: Long, code: String) {
        mapper.finish(runId, "UNKNOWN", null, code, now())
    }

    private fun now(): LocalDateTime = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
    private fun CombinationReviewRunDbRow.toDomain(): StoredCombinationReviewRun = StoredCombinationReviewRun(
        id, reviewId, inputRevision, requestKey, requestHash, ReviewRunStatus.valueOf(status),
        json.readValue(inputJson, ReviewRunSnapshot::class.java),
        evidenceJson?.let { json.readValue(it, ReviewEvidenceSnapshot::class.java) },
        configurationJson?.let { json.readValue(it, ReviewModelConfiguration::class.java) },
        analysisJson?.let { json.readValue(it, ReviewAnalysis::class.java) },
        failureCode, runnerInstanceId, requireNotNull(startedAt), finishedAt,
    )
}
