package ai.govbiz.core.applicationpreparation.controller.dto

import jakarta.validation.constraints.Min

data class GenerateApplicationDocumentsRequest(@field:Min(1) val expectedRevision: Long)
data class ApplicationDocumentUnfilledAnswerResponse(val fieldId: String, val fieldLabel: String, val value: String, val reason: String)
data class ApplicationDocumentResponse(
    val id: Long,
    val inputRevision: Long,
    val fileName: String,
    val mediaType: String,
    val size: Int,
    val filledAnswerCount: Int?,
    val unfilledAnswerCount: Int?,
    val unfilledAnswers: List<ApplicationDocumentUnfilledAnswerResponse>,
)

data class ApplicationDocumentGenerationJobRequest(
    @field:jakarta.validation.constraints.Pattern(regexp = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}") val requestKey: String,
    @field:Min(1) val expectedRevision: Long,
)

data class ApplicationDocumentGenerationJobResponse(
    val id: Long,
    val preparationId: Long,
    val expectedRevision: Long,
    val status: String,
    val stage: String?,
    val fileIds: List<Long>,
    val failureCode: String?,
    val failureMessage: String?,
    val mappingMigration: ApplicationDocumentMigrationNoticeResponse?,
    val createdAt: java.time.OffsetDateTime,
    val finishedAt: java.time.OffsetDateTime?,
    /** 끝난 결과를 사용자가 확인했는지. 진행 중·결과 불명 작업에서는 뜻이 없다. */
    val seen: Boolean,
) {
    companion object {
        fun from(job: ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationJob,
                 migration: ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentMigrationNoticeResult?) =
            ApplicationDocumentGenerationJobResponse(
                job.id, job.preparationId, job.expectedRevision, job.status.name, job.stage?.name, job.fileIds,
                job.failureCode, job.failureMessage,
                migration?.let { notice -> ApplicationDocumentMigrationNoticeResponse(
                    approvalToken = notice.approvalToken, expectedRevision = notice.expectedRevision, expiresInSeconds = notice.expiresInSeconds,
                    changes = notice.changes.map { ApplicationDocumentMappingChangeResponse(it.fieldLabel, it.changeType, it.oldLocation, it.newLocation) }) },
                job.createdAt.atZone(java.time.ZoneId.of("Asia/Seoul")).toOffsetDateTime(),
                job.finishedAt?.atZone(java.time.ZoneId.of("Asia/Seoul"))?.toOffsetDateTime(), job.seenAt != null,
            )
    }
}
