package ai.govbiz.core.applicationpreparation.service.dto

data class ApplicationDocumentMappingChangeResult(
    val fieldLabel: String,
    val changeType: String,
    val oldLocation: String?,
    val newLocation: String?,
)

data class ApplicationDocumentMigrationNoticeResult(
    val approvalToken: String,
    val expectedRevision: Long,
    val expiresInSeconds: Int = 900,
    val changes: List<ApplicationDocumentMappingChangeResult>,
)

data class ApplicationDocumentMigrationConfirmedResult(
    val preparationId: Long,
    val inputRevision: Long,
    val formVersionId: String,
)
