package ai.govbiz.core.applicationpreparation.controller.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryJob
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.time.OffsetDateTime
import java.time.ZoneId

data class ApplicationFormDiscoveryJobRequest(
    @field:Pattern(regexp = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}") val requestKey: String,
    @field:Pattern(regexp = "BIZINFO|KSTARTUP|MSIT|CNTRADE_NOTICE") val sourceCode: String,
    @field:NotBlank @field:Size(max = 255) val sourceProgramId: String,
)

data class ApplicationFormDiscoveryJobResponse(
    val id: Long,
    val sourceCode: String,
    val sourceProgramId: String,
    val programTitle: String,
    val programSourceUrl: String?,
    val status: String,
    val result: DiscoveredApplicationFormsResponse?,
    val failureCode: String?,
    val createdAt: OffsetDateTime,
) {
    companion object {
        fun from(job: ApplicationFormDiscoveryJob) = ApplicationFormDiscoveryJobResponse(
            job.id, job.sourceCode, job.sourceProgramId, job.programTitle, job.programSourceUrl, job.status.name,
            job.result?.let(DiscoveredApplicationFormsResponse::from), job.failureCode,
            job.createdAt.atZone(ZoneId.of("Asia/Seoul")).toOffsetDateTime(),
        )
    }
}
