package ai.govbiz.core.assistant.controller.dto

import ai.govbiz.core.assistant.domain.AssistantCompanyProfile
import ai.govbiz.core.assistant.domain.AssistantRecruitmentSummary
import ai.govbiz.core.assistant.domain.AssistantSavedProgramSummary

/** 도구 응답은 AI Service 도구 스키마(`app/assistant_agent/tools.py`)와 필드 이름이 같아야 합니다. */
data class AssistantCompanyProfileResponse(
    val registered: Boolean,
    val companyName: String?,
    val region: String?,
    val industry: String?,
    val foundedYear: Int?,
    val roles: List<String>,
    val interestAreas: List<String>,
    val introduction: String?,
    val capabilities: List<String>,
) {
    companion object {
        fun from(profile: AssistantCompanyProfile) = AssistantCompanyProfileResponse(
            profile.registered, profile.companyName, profile.region, profile.industry, profile.foundedYear,
            profile.roles, profile.interestAreas, profile.introduction, profile.capabilities,
        )
    }
}

data class AssistantRecruitmentResponse(
    val id: Long,
    val title: String,
    val companyName: String,
    val companyRegion: String,
    val companyIndustry: String,
    val ownRole: String,
    val seekingRole: String,
    val seekingCount: Int,
    val region: String,
    val minimumCompanyAgeYears: Int?,
    val capabilities: List<String>,
    val recruitmentDeadline: String,
    val programTitle: String,
    val programApplicationEndDate: String?,
    val body: String,
) {
    companion object {
        fun from(summary: AssistantRecruitmentSummary) = AssistantRecruitmentResponse(
            summary.id, summary.title, summary.companyName, summary.companyRegion, summary.companyIndustry,
            summary.ownRole, summary.seekingRole, summary.seekingCount, summary.region, summary.minimumCompanyAgeYears,
            summary.capabilities, summary.recruitmentDeadline.toString(), summary.programTitle,
            summary.programApplicationEndDate?.toString(), summary.body,
        )
    }
}

data class AssistantSavedProgramResponse(
    val sourceCode: String,
    val sourceProgramId: String,
    val title: String,
    val organization: String,
    val applicationEndDate: String?,
    val status: String,
    val documentId: String?,
) {
    companion object {
        fun from(summary: AssistantSavedProgramSummary) = AssistantSavedProgramResponse(
            summary.sourceCode, summary.sourceProgramId, summary.title, summary.organization,
            summary.applicationEndDate?.toString(), summary.status, summary.documentId,
        )
    }
}
