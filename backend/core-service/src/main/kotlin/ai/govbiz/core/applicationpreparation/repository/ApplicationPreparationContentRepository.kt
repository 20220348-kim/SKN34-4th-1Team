package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationContentFact
import ai.govbiz.core.applicationpreparation.domain.ApplicationContentVersion
import ai.govbiz.core.applicationpreparation.domain.ApplicationDraftInput
import ai.govbiz.core.applicationpreparation.domain.ApplicationDraftOutput
import ai.govbiz.core.applicationpreparation.domain.ApplicationDraftReservation
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationContentDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationContentMapper
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationDraftRunDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationInputMapper
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

/** 준비 건의 행 잠금으로 입력 변경과 작성본 저장을 직렬화하며 이전 작성본은 보존한다. */
@Repository
class ApplicationPreparationContentRepository(
    private val mapper: ApplicationPreparationContentMapper,
    private val inputs: ApplicationPreparationInputMapper,
    private val json: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun listOwned(ownerId: Long, preparationId: Long) = mapper.listOwned(ownerId, preparationId).map { it.toDomain() }

    @Transactional
    fun reserve(ownerId: Long, input: ApplicationDraftInput, expectedVersionId: Long?, requestKey: String): ApplicationDraftReservation {
        val revision = inputs.lockOwnedRevision(ownerId, input.preparationId) ?: throw ApplicationPreparationNotFoundException()
        mapper.findRequest(input.preparationId, requestKey)?.let { previous ->
            if (previous.sectionKey != input.section.key || previous.inputRevision != input.inputRevision || previous.expectedVersionId != expectedVersionId || previous.runStatus != "SUCCEEDED") {
                throw ApplicationPreparationRunConflictException()
            }
            return ApplicationDraftReservation(previous.id, true, previous.applied)
        }
        if (revision != input.inputRevision || mapper.latest(input.preparationId, input.section.key)?.id != expectedVersionId) conflict()
        if (mapper.hasRunning(input.preparationId, input.section.key)) throw ApplicationPreparationRunConflictException()
        val row = ApplicationPreparationDraftRunDbRow(
            preparationId = input.preparationId, sectionKey = input.section.key, inputRevision = input.inputRevision,
            expectedVersionId = expectedVersionId, requestKey = requestKey, inputJson = json.writeValueAsString(input), startedAt = now(),
        )
        check(mapper.insertRun(row) == 1)
        return ApplicationDraftReservation(row.id, false, false)
    }

    @Transactional
    fun complete(ownerId: Long, runId: Long, input: ApplicationDraftInput, expectedVersionId: Long?, output: ApplicationDraftOutput): Boolean {
        val revision = inputs.lockOwnedRevision(ownerId, input.preparationId) ?: throw ApplicationPreparationNotFoundException()
        val applied = revision == input.inputRevision && mapper.latest(input.preparationId, input.section.key)?.id == expectedVersionId
        check(mapper.finishRun(runId, "SUCCEEDED", json.writeValueAsString(output), applied, now()) == 1)
        if (applied) {
            check(mapper.insertVersion(ApplicationPreparationContentDbRow(
                preparationId = input.preparationId, sectionKey = input.section.key, inputRevision = input.inputRevision,
                contentText = output.content, factsJson = json.writeValueAsString(input.facts), runId = runId, createdAt = now(),
            )) == 1)
            mapper.touch(input.preparationId, now())
        }
        return applied
    }

    @Transactional
    fun fail(runId: Long) {
        // 삭제된 준비 건이나 이미 종료한 실행의 오류 처리로 원래 오류를 가리지 않는다.
        mapper.finishRun(runId, "FAILED", null, false, now())
    }

    @Transactional
    fun save(ownerId: Long, preparationId: Long, sectionKey: String, expectedRevision: Long, expectedVersionId: Long, content: String) {
        requireCurrent(ownerId, preparationId, expectedRevision)
        val previous = mapper.latest(preparationId, sectionKey) ?: conflict()
        if (previous.id != expectedVersionId) conflict()
        check(mapper.insertVersion(previous.copy(
            id = 0, contentKind = "USER_EDIT", contentText = content, createdAt = now(), confirmedAt = null,
        )) == 1)
        mapper.touch(preparationId, now())
    }

    @Transactional
    fun confirm(ownerId: Long, preparationId: Long, sectionKey: String, expectedRevision: Long, expectedVersionId: Long) {
        requireCurrent(ownerId, preparationId, expectedRevision)
        val version = mapper.latest(preparationId, sectionKey) ?: conflict()
        if (version.id != expectedVersionId) conflict()
        val currentFacts = inputs.listSectionFacts(preparationId, sectionKey).sortedBy { it.fieldKey }
            .map { ApplicationContentFact(it.fieldKey, it.factStatus, it.valueText) }
        if (version.toDomain().facts != currentFacts) conflict()
        mapper.confirm(version.id, now())
        mapper.touch(preparationId, now())
    }

    private fun requireCurrent(ownerId: Long, preparationId: Long, expectedRevision: Long) {
        val revision = inputs.lockOwnedRevision(ownerId, preparationId) ?: throw ApplicationPreparationNotFoundException()
        if (revision != expectedRevision) conflict()
    }

    private fun ApplicationPreparationContentDbRow.toDomain() = ApplicationContentVersion(
        id, sectionKey, inputRevision, contentKind, contentText,
        json.readValue(factsJson, Array<ApplicationContentFact>::class.java).toList(), requireNotNull(createdAt), confirmedAt,
    )

    private fun conflict(): Nothing = throw ApplicationPreparationRevisionConflictException()
    private fun now() = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
}
