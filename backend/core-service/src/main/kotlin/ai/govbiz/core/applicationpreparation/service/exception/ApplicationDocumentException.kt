package ai.govbiz.core.applicationpreparation.service.exception

import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentMigrationNoticeResult

class ApplicationDocumentException(
    val code: String,
    message: String,
    cause: Throwable? = null,
    val mappingMigration: ApplicationDocumentMigrationNoticeResult? = null,
) : RuntimeException(message, cause)
