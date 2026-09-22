package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService

/**
 * 공고 상세 조회 응답입니다. 검색 결과와 달리 관련도·추천 이유·자격 판정을 담지 않으며,
 * 상세 화면이 제공처를 직접 비교하지 않도록 원문 근거 질문 지원 여부를 서버가 정합니다.
 */
data class SupportProgramDetailResponse(
    val id: String,
    val sourceCode: String,
    val title: String,
    val organization: String,
    val summary: String,
    val categories: List<String>,
    val regions: List<String>,
    val targetDescription: String,
    val applicationPeriod: String,
    val applicationStartDate: String?,
    val applicationEndDate: String?,
    val status: SupportProgramStatus,
    val sourceName: String,
    val sourceUrl: String,
    val evidenceQuestionSupported: Boolean,
) {
    companion object {
        fun from(program: SupportProgram): SupportProgramDetailResponse =
            SupportProgramDetailResponse(
                id = program.id,
                sourceCode = program.sourceCode,
                title = program.title,
                organization = program.organization,
                summary = program.summary,
                categories = program.categories,
                regions = program.regions,
                targetDescription = program.targetDescription,
                applicationPeriod = program.applicationPeriod,
                applicationStartDate = program.applicationStartDate?.toString(),
                applicationEndDate = program.applicationEndDate?.toString(),
                status = program.status,
                sourceName = program.sourceName,
                sourceUrl = program.sourceUrl,
                evidenceQuestionSupported = program.sourceCode == SupportProgramEvidenceService.BIZINFO_SOURCE_CODE,
            )
    }
}
