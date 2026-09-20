package ai.govbiz.core.assistant.domain

import java.time.LocalDate

/**
 * 도우미 도구가 읽는 내 기업 요약입니다. 연락처·사업자등록번호·이메일은 넣지 않습니다.
 * 기업이 없으면 `registered=false`이고 나머지는 비어 있습니다.
 */
data class AssistantCompanyProfile(
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
        val NOT_REGISTERED = AssistantCompanyProfile(false, null, null, null, null, emptyList(), emptyList(), null, emptyList())
    }
}

/** 모집 중인 남의 모집글 요약입니다. 본문은 잘라 넣고 담당자 정보는 넣지 않습니다. */
data class AssistantRecruitmentSummary(
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
    val recruitmentDeadline: LocalDate,
    val programTitle: String,
    val programApplicationEndDate: LocalDate?,
    val body: String,
)

/** 관심 공고 요약입니다. `documentId`는 원문이 수집돼 근거 검색을 할 수 있을 때만 있습니다. */
data class AssistantSavedProgramSummary(
    val sourceCode: String,
    val sourceProgramId: String,
    val title: String,
    val organization: String,
    val applicationEndDate: LocalDate?,
    val status: String,
    val documentId: String?,
)
