package ai.govbiz.core.applicationpreparation.controller.dto

import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentDownloadLinkResult
import java.time.OffsetDateTime

data class ApplicationDocumentDownloadLinkResponse(
    val preparationId: Long,
    val fileId: Long,
    val downloadPath: String,
    val expiresAt: OffsetDateTime,
) {
    companion object {
        fun from(result: ApplicationDocumentDownloadLinkResult) = ApplicationDocumentDownloadLinkResponse(
            preparationId = result.preparationId,
            fileId = result.fileId,
            downloadPath = "/api/v1/application-preparations/${result.preparationId}/documents/${result.fileId}/download?ticket=${result.ticket}",
            expiresAt = result.expiresAt,
        )
    }
}
