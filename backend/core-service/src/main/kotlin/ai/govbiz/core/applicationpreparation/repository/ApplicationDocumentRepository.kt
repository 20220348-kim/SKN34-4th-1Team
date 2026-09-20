package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFile
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentUnfilledAnswer
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationDocumentDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationDocumentMapper
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationInputMapper
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

@Repository
class ApplicationDocumentRepository(private val mapper: ApplicationDocumentMapper, private val inputs: ApplicationPreparationInputMapper, private val json: ObjectMapper) {
    fun listOwned(ownerId: Long, preparationId: Long) = mapper.listOwned(ownerId, preparationId, 20).map { it.toDomain() }
    fun findRevision(ownerId: Long, preparationId: Long, revision: Long) = mapper.findRevision(ownerId, preparationId, revision, 5)?.toDomain()
    fun findOwned(ownerId: Long, preparationId: Long, fileId: Long) = mapper.findOwned(ownerId, preparationId, fileId)?.toDomain()
    fun findFingerprint(ownerId: Long, preparationId: Long, revision: Long, fingerprint: String) = mapper.findFingerprint(ownerId, preparationId, revision, fingerprint)?.toDomain()

    @Transactional
    fun save(ownerId: Long, preparationId: Long, revision: Long, fileName: String, mediaType: String, bytes: ByteArray, sourceSha256: String, placements: List<ApplicationDocumentPlacement>, clearExampleTargetIds: List<String> = emptyList(), fingerprint: String? = null, evidence: Map<String, Any?> = emptyMap(), filledAnswerCount: Int? = null, unfilledAnswers: List<ApplicationDocumentUnfilledAnswer> = emptyList()): ApplicationDocumentFile {
        val current = inputs.lockOwnedRevision(ownerId, preparationId) ?: throw ApplicationPreparationNotFoundException()
        if (current != revision) throw ApplicationPreparationRevisionConflictException()
        (if (fingerprint == null) findRevision(ownerId, preparationId, revision) else findFingerprint(ownerId, preparationId, revision, fingerprint))?.let { return it }
        val metadata = mutableMapOf<String, Any?>("placements" to placements, "clearExampleTargetIds" to clearExampleTargetIds, "mcp" to evidence)
        if (filledAnswerCount != null) metadata["answerSummary"] = mapOf("filledAnswerCount" to filledAnswerCount, "unfilledAnswers" to unfilledAnswers)
        val row = ApplicationDocumentDbRow(preparationId = preparationId, inputRevision = revision, fileName = fileName, mediaType = mediaType, fileBytes = bytes, sourceSha256 = sourceSha256, placementsJson = json.writeValueAsString(metadata), generatorVersion = if (fingerprint == null) 5 else 6, generationFingerprint = fingerprint ?: "")
        check(mapper.insert(row) == 1)
        return row.toDomain()
    }

    private fun ApplicationDocumentDbRow.toDomain(): ApplicationDocumentFile {
        val summary = json.readTree(placementsJson).path("answerSummary")
        if (summary.isMissingNode || summary.isNull) return ApplicationDocumentFile(id, inputRevision, fileName, mediaType, fileBytes)
        val unfilled = mutableListOf<ApplicationDocumentUnfilledAnswer>()
        summary.path("unfilledAnswers").forEach { node ->
            unfilled += json.treeToValue(node, ApplicationDocumentUnfilledAnswer::class.java)
        }
        return ApplicationDocumentFile(id, inputRevision, fileName, mediaType, fileBytes, summary.path("filledAnswerCount").asInt(), unfilled)
    }
}
