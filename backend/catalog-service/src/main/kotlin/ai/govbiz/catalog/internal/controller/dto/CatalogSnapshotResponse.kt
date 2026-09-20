package ai.govbiz.catalog.internal.controller.dto

import ai.govbiz.catalog.supportprogram.domain.CatalogSnapshot
import ai.govbiz.catalog.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.catalog.supportprogram.domain.SupportProgram
import ai.govbiz.catalog.supportprogram.domain.SupportProgramStartupDetails
import ai.govbiz.catalog.supportprogram.domain.SupportProgramSyncStatus
import java.time.LocalDate
import java.time.LocalDateTime

data class CatalogSnapshotResponse(
    val schemaVersion: Int,
    val catalogId: String,
    val revision: Long,
    val status: CatalogSyncStatusResponse,
    val programs: List<CatalogProgramResponse>,
) {
    companion object {
        fun from(snapshot: CatalogSnapshot) = CatalogSnapshotResponse(
            1, snapshot.catalogId, snapshot.revision, CatalogSyncStatusResponse.from(snapshot.status),
            snapshot.programs.map(CatalogProgramResponse::from),
        )
    }
}

/** 내부 모델의 계산용 속성을 자동 직렬화하지 않고 서비스 사이의 계약을 고정합니다. */
data class CatalogSyncStatusResponse(
    val sourceCode: String,
    val publishedGeneration: Long?,
    val publishedCatalogFingerprint: String?,
    val publishedProgramCount: Int,
    val indexReady: Boolean,
    val lastSuccessfulSyncAt: LocalDateTime?,
    val lastFailedSyncAt: LocalDateTime?,
    val lastSyncOutcome: String,
) {
    companion object {
        fun from(status: SupportProgramSyncStatus) = CatalogSyncStatusResponse(
            status.sourceCode, status.publishedGeneration, status.publishedCatalogFingerprint,
            status.publishedProgramCount, status.indexReady, status.lastSuccessfulSyncAt,
            status.lastFailedSyncAt, status.lastSyncOutcome.name,
        )
    }
}

data class CatalogProgramResponse(
    val program: CatalogProgramDetailsResponse,
    val sortTimestamp: String,
    val startupDetails: CatalogStartupDetailsResponse?,
) {
    companion object {
        fun from(program: CatalogSupportProgram) = CatalogProgramResponse(
            CatalogProgramDetailsResponse.from(program.program), program.sortTimestamp,
            program.startupDetails?.let(CatalogStartupDetailsResponse::from),
        )
    }
}

data class CatalogProgramDetailsResponse(
    val id: String,
    val sourceCode: String,
    val title: String,
    val organization: String,
    val summary: String,
    val categories: List<String>,
    val regions: List<String>,
    val targetDescription: String,
    val applicationPeriod: String,
    val applicationStartDate: LocalDate?,
    val applicationEndDate: LocalDate?,
    val status: String,
    val sourceName: String,
    val sourceUrl: String,
) {
    companion object {
        fun from(program: SupportProgram) = CatalogProgramDetailsResponse(
            program.id, program.sourceCode, program.title, program.organization, program.summary,
            program.categories, program.regions, program.targetDescription, program.applicationPeriod,
            program.applicationStartDate, program.applicationEndDate, program.status.name,
            program.sourceName, program.sourceUrl,
        )
    }
}

data class CatalogStartupDetailsResponse(
    val startupStages: List<String>,
    val applicantTypes: List<String>,
    val founderAges: List<String>,
) {
    companion object {
        fun from(details: SupportProgramStartupDetails) = CatalogStartupDetailsResponse(
            details.startupStages, details.applicantTypes, details.founderAges,
        )
    }
}
