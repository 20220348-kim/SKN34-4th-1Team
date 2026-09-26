package ai.govbiz.core.applicationpreparation.controller.dto

import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Pattern

data class ApplicationDocumentMappingChangeResponse(
    val fieldLabel: String,
    val changeType: String,
    val oldLocation: String?,
    val newLocation: String?,
)

data class ApplicationDocumentMigrationNoticeResponse(
    val status: String = "MAPPING_CHANGED",
    val approvalToken: String,
    val expectedRevision: Long,
    val expiresInSeconds: Int = 900,
    val changes: List<ApplicationDocumentMappingChangeResponse>,
)

data class ConfirmApplicationDocumentMigrationRequest(
    @field:Min(1) val expectedRevision: Long,
    @field:Pattern(regexp = "[0-9a-f-]{36}") val approvalToken: String,
)

data class ApplicationDocumentMigrationConfirmedResponse(
    val status: String = "REGENERATION_REQUIRED",
    val preparationId: Long,
    val inputRevision: Long,
    val formVersionId: String,
)
