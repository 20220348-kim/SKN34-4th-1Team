package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationFactStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationInputReplaceResult
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretation
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretationInputSnapshot
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretationReservation
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretationRunStatus
import ai.govbiz.core.applicationpreparation.domain.ConfirmedApplicationFact
import ai.govbiz.core.applicationpreparation.domain.NewConfirmedApplicationFact
import ai.govbiz.core.applicationpreparation.domain.StoredApplicationInterpretationRun
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationInterpretationRunDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationFactDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationInputMapper
import java.security.MessageDigest
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Isolation
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

/** 문항별 확인 사실과 해석 실행 이력을 짧은 MySQL transaction으로 저장합니다. */
@Repository
class ApplicationPreparationInputRepository(
    private val mapper: ApplicationPreparationInputMapper,
    private val json: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun listOwnedFacts(ownerId: Long, preparationId: Long): List<ConfirmedApplicationFact> =
        mapper.listOwnedFacts(ownerId, preparationId).map { row -> row.toDomain() }

    @Transactional(isolation = Isolation.REPEATABLE_READ)
    fun replaceOwned(
        ownerId: Long,
        preparationId: Long,
        sectionKey: String,
        expectedRevision: Long,
        facts: List<NewConfirmedApplicationFact>,
    ): ApplicationInputReplaceResult {
        val currentRevision = mapper.lockOwnedRevision(ownerId, preparationId) ?: return ApplicationInputReplaceResult.NotFound
        if (currentRevision != expectedRevision) return ApplicationInputReplaceResult.RevisionConflict
        val nextRevision = currentRevision + 1
        val now = now()
        mapper.deleteSectionFacts(preparationId, sectionKey)
        facts.forEach { fact ->
            val row = ApplicationPreparationFactDbRow(
                preparationId = preparationId,
                sectionKey = sectionKey,
                fieldKey = fact.fieldKey,
                factStatus = fact.status.name,
                valueText = fact.value,
                sourceText = fact.sourceText,
                inputRevision = nextRevision,
                createdAt = now,
                updatedAt = now,
            )
            check(mapper.insertFact(row) == 1 && row.id > 0)
        }
        check(mapper.updatePreparationRevision(preparationId, currentRevision, nextRevision, now) == 1)
        return ApplicationInputReplaceResult.Updated(nextRevision)
    }

    @Transactional(isolation = Isolation.REPEATABLE_READ)
    fun reserveInterpretation(
        ownerId: Long,
        preparationId: Long,
        expectedRevision: Long,
        requestKey: String,
        snapshot: ApplicationInterpretationInputSnapshot,
    ): ApplicationInterpretationReservation {
        val currentRevision = mapper.lockOwnedRevision(ownerId, preparationId) ?: throw ApplicationPreparationNotFoundException()
        val requestHash = sha256("$expectedRevision\n${snapshot.sectionKey}\n${snapshot.userMessage}")
        mapper.findRequest(preparationId, requestKey)?.let { existing ->
            if (existing.requestHash != requestHash) throw ApplicationPreparationRunConflictException()
            val run = existing.toDomain()
            if (run.status != ApplicationInterpretationRunStatus.SUCCEEDED) throw ApplicationPreparationRunConflictException()
            return ApplicationInterpretationReservation(run, false)
        }
        if (currentRevision != expectedRevision) throw ApplicationPreparationRevisionConflictException()
        val row = ApplicationInterpretationRunDbRow(
            preparationId = preparationId,
            sectionKey = snapshot.sectionKey,
            inputRevision = expectedRevision,
            requestKey = requestKey,
            requestHash = requestHash,
            inputJson = json.writeValueAsString(snapshot),
            startedAt = now(),
        )
        check(mapper.insertRun(row) == 1 && row.id > 0)
        return ApplicationInterpretationReservation(row.toDomain(), true)
    }

    @Transactional
    fun succeed(runId: Long, output: ApplicationInterpretation) {
        check(mapper.finishRun(runId, "SUCCEEDED", json.writeValueAsString(output), null, now()) == 1)
    }

    @Transactional
    fun fail(runId: Long, failureCode: String) {
        check(mapper.finishRun(runId, "FAILED", null, failureCode, now()) == 1)
    }

    private fun ApplicationPreparationFactDbRow.toDomain() = ConfirmedApplicationFact(
        id = id,
        sectionKey = sectionKey,
        fieldKey = fieldKey,
        status = ApplicationFactStatus.valueOf(factStatus),
        value = valueText,
        sourceText = sourceText,
        inputRevision = inputRevision,
        updatedAt = requireNotNull(updatedAt),
    )

    private fun ApplicationInterpretationRunDbRow.toDomain() = StoredApplicationInterpretationRun(
        id = id,
        preparationId = preparationId,
        inputRevision = inputRevision,
        requestKey = requestKey,
        requestHash = requestHash,
        status = ApplicationInterpretationRunStatus.valueOf(runStatus),
        input = json.readValue(inputJson, ApplicationInterpretationInputSnapshot::class.java),
        output = outputJson?.let { json.readValue(it, ApplicationInterpretation::class.java) },
        failureCode = failureCode,
        startedAt = requireNotNull(startedAt),
        finishedAt = finishedAt,
    )

    private fun now(): LocalDateTime = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
