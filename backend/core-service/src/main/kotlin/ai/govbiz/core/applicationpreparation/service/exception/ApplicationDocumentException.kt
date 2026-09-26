package ai.govbiz.core.applicationpreparation.service.exception

import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentMigrationNoticeResponse

class ApplicationDocumentException(
    val code: String,
    message: String,
    cause: Throwable? = null,
    val mappingMigration: ApplicationDocumentMigrationNoticeResponse? = null,
) : RuntimeException(message, cause)
