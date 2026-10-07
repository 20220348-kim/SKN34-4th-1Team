package ai.govbiz.core.applicationpreparation.service.dto

import java.time.OffsetDateTime

data class ApplicationDocumentDownloadLinkResult(
    val preparationId: Long,
    val fileId: Long,
    val ticket: String,
    val expiresAt: OffsetDateTime,
)
