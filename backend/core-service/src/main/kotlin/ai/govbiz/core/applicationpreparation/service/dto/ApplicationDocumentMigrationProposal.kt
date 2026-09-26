package ai.govbiz.core.applicationpreparation.service.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMapSnapshot
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement

/** Short-lived approval candidate; never the active form map. */
data class ApplicationDocumentMigrationProposal(
    val ownerId: Long,
    val preparationId: Long,
    val oldFormVersionId: String,
    val expectedRevision: Long,
    val sourceSha256: String,
    val oldPipelineVersion: String,
    val oldMapVersion: String,
    val oldBindings: List<ApplicationDocumentPlacement>,
    val oldScopeTargetIds: List<String>,
    val proposed: ApplicationDocumentMapSnapshot,
)
