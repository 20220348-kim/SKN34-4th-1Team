package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryConfiguration
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormSnapshotDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormSnapshotMapper
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

@Repository
class ApplicationFormSnapshotRepository(
    private val mapper: ApplicationFormSnapshotMapper,
    private val json: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    @Transactional
    fun save(
        forms: List<ApplicationFormManifest>,
        sourceFingerprint: String,
        parserVersion: String,
        configuration: ApplicationFormDiscoveryConfiguration,
    ) {
        forms.forEach { form ->
            mapper.upsert(
                ApplicationFormSnapshotDbRow(
                    formVersionId = form.formVersionId,
                    sourceCode = form.sourceCode,
                    sourceProgramId = form.sourceProgramId,
                    sourceFingerprint = sourceFingerprint,
                    attachmentSha256 = form.attachmentSha256,
                    manifestJson = json.writeValueAsString(form),
                    parserVersion = parserVersion,
                    extractionModel = configuration.model,
                    extractionPromptVersion = configuration.promptVersion,
                    createdAt = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS),
                ),
            )
        }
    }

    @Transactional
    fun attachDocumentMap(formVersionId: String, snapshot: ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMapSnapshot): ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMapSnapshot {
        mapper.attachDocumentMap(formVersionId, snapshot.sourceSha256, snapshot.pipelineVersion, json.writeValueAsString(snapshot))
        return requireNotNull(findByVersion(formVersionId)?.documentMapSnapshot)
    }

    fun findByVersion(formVersionId: String): ApplicationFormManifest? =
        mapper.findByVersion(formVersionId)?.toManifest()

    fun findByProgram(
        sourceCode: String,
        sourceProgramId: String,
        sourceFingerprint: String,
        parserVersion: String,
        extractionModel: String,
        promptVersion: String,
    ): List<ApplicationFormManifest> =
        mapper.findByProgram(sourceCode, sourceProgramId, sourceFingerprint, parserVersion, extractionModel, promptVersion)
            .sortedBy { row -> row.formVersionId }
            .map { row -> row.toManifest() }

    private fun ApplicationFormSnapshotDbRow.toManifest(): ApplicationFormManifest =
        json.readValue(manifestJson, ApplicationFormManifest::class.java).also { form ->
            require(form.formVersionId == formVersionId && form.sourceCode == sourceCode &&
                form.sourceProgramId == sourceProgramId && form.attachmentSha256 == attachmentSha256)
        }
}
