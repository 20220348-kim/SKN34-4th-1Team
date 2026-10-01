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

/** 한 공고의 끝난 분석 결과를 확인했다고 표시하는 요청이다. */
data class ApplicationFormDiscoverySeenRequest(
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
    /** 끝난 결과를 사용자가 확인했는지. 진행 중·결과 불명 작업에서는 뜻이 없다. */
    val seen: Boolean,
) {
    companion object {
        fun from(job: ApplicationFormDiscoveryJob) = ApplicationFormDiscoveryJobResponse(
            job.id, job.sourceCode, job.sourceProgramId, job.programTitle, job.programSourceUrl, job.status.name,
            job.result?.let(DiscoveredApplicationFormsResponse::from), job.failureCode,
            job.createdAt.atZone(ZoneId.of("Asia/Seoul")).toOffsetDateTime(), job.seenAt != null,
        )
    }
}
