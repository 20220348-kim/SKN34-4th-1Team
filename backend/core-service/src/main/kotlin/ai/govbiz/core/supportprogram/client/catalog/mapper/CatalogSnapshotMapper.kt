package ai.govbiz.core.supportprogram.client.catalog.mapper

import ai.govbiz.core.supportprogram.client.catalog.dto.CatalogSnapshotResponse
import ai.govbiz.core.supportprogram.domain.CatalogProjectionSnapshot
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStartupDetails
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncOutcome
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncStatus

/** HTTP 계약의 필드를 명시적으로 변환하여 외부 응답과 Core 업무 모델을 분리합니다. */
object CatalogSnapshotMapper {
    fun toDomain(response: CatalogSnapshotResponse): CatalogProjectionSnapshot = CatalogProjectionSnapshot(
        catalogId = response.catalogId,
        revision = response.revision,
        status = response.status.let {
            SupportProgramSyncStatus(
                it.sourceCode, it.publishedGeneration, it.publishedCatalogFingerprint, it.publishedProgramCount,
                it.indexReady, it.lastSuccessfulSyncAt, it.lastFailedSyncAt, SupportProgramSyncOutcome.valueOf(it.lastSyncOutcome),
            )
        },
        programs = response.programs.map { item ->
            CatalogSupportProgram(
                program = item.program.let {
                    SupportProgram(
                        id = it.id, sourceCode = it.sourceCode, title = it.title, organization = it.organization,
                        summary = it.summary, categories = it.categories, regions = it.regions,
                        targetDescription = it.targetDescription, applicationPeriod = it.applicationPeriod,
                        applicationStartDate = it.applicationStartDate, applicationEndDate = it.applicationEndDate,
                        status = SupportProgramStatus.valueOf(it.status), sourceName = it.sourceName,
                        sourceUrl = it.sourceUrl, matchedReasons = emptyList(),
                    )
                },
                sortTimestamp = item.sortTimestamp,
                startupDetails = item.startupDetails?.let {
                    SupportProgramStartupDetails(it.startupStages, it.applicantTypes, it.founderAges)
                },
            )
        },
    )
}
