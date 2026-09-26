package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormSnapshotDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormSnapshotMapper
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationMapper
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentMigrationProposal
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import java.security.MessageDigest
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

/** Atomically gives one preparation its own approved form snapshot. */
@Repository
class ApplicationDocumentMigrationRepository(
    private val forms: ApplicationFormSnapshotMapper,
    private val preparations: ApplicationPreparationMapper,
    private val json: ObjectMapper,
) {
    @Transactional
    fun approve(proposal: ApplicationDocumentMigrationProposal): String {
        fun stale(): Nothing = throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_MIGRATION_STALE",
            "확인 중 답변 또는 양식이 변경됐습니다. 변경 내용을 다시 확인해 주세요.")
        val preparation = preparations.findOwnedForUpdate(proposal.ownerId, proposal.preparationId) ?: stale()
        if (preparation.formVersionId != proposal.oldFormVersionId) stale()
        val source = forms.findByVersionForUpdate(proposal.oldFormVersionId) ?: stale()
        val manifest = json.readValue(source.manifestJson, ApplicationFormManifest::class.java)
        val old = manifest.documentMapSnapshot ?: stale()
        if (source.attachmentSha256 != proposal.sourceSha256 ||
            old.sourceSha256 != proposal.sourceSha256 ||
            old.pipelineVersion != proposal.oldPipelineVersion || old.mapVersion != proposal.oldMapVersion ||
            old.bindings.toSet() != proposal.oldBindings.toSet() ||
            old.scopeTargetIds.toSet() != proposal.oldScopeTargetIds.toSet() ||
            proposal.proposed.sourceSha256 != proposal.sourceSha256) stale()
        val identity = sha256("${proposal.oldFormVersionId}\u0000${proposal.preparationId}\u0000${proposal.proposed.pipelineVersion}")
        val newVersion = "approved-${identity.take(40)}"
        val newFingerprint = sha256("approved\u0000${proposal.preparationId}\u0000$identity")
        val approved = manifest.copy(formVersionId = newVersion, documentMapSnapshot = proposal.proposed)
        val row = ApplicationFormSnapshotDbRow(formVersionId = newVersion, sourceFingerprint = newFingerprint,
            manifestJson = json.writeValueAsString(approved))
        if (forms.insertApprovedSnapshot(proposal.oldFormVersionId, row) != 1 ||
            preparations.updateFormVersionOwned(proposal.ownerId, proposal.preparationId,
                proposal.oldFormVersionId, newVersion, proposal.expectedRevision) != 1) stale()
        return newVersion
    }

    private fun sha256(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
