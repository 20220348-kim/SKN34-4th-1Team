package ai.govbiz.core.applicationpreparation.repository.mapper

import java.time.LocalDateTime

data class ApplicationFormSnapshotDbRow(
    var formVersionId: String = "",
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var sourceFingerprint: String = "",
    var attachmentSha256: String = "",
    var manifestJson: String = "",
    var parserVersion: String = "",
    var extractionModel: String = "",
    var extractionPromptVersion: String = "",
    var createdAt: LocalDateTime? = null,
)
