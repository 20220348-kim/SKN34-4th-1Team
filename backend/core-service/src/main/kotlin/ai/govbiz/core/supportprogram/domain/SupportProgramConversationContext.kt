package ai.govbiz.core.supportprogram.domain

/** 한 번의 대화 해석에 사용하는 검색 상태입니다. 로그인 복원용 임시 스냅샷에도 포함됩니다. */
data class SupportProgramConversationContext(
    val query: String?,
    val acceptingOnly: Boolean,
    val companyConditions: SupportProgramCompanyConditions,
)

data class SupportProgramPendingClarification(
    val question: String,
    val draftContext: SupportProgramConversationContext,
)

/** 직전 완료 검색의 참고 정보이며 적용 조건이나 실행 명령이 아닙니다. */
data class SupportProgramConversationLastSearch(
    val context: SupportProgramConversationContext,
    val resultCount: Int,
)

enum class SupportProgramConversationStatus { READY, CLARIFICATION_REQUIRED, ANSWERED }

enum class SupportProgramConversationField {
    QUERY, REGION, INDUSTRY, ESTABLISHED_ON, FOUNDED_YEAR, SUPPORT_PURPOSE, ACCEPTING_ONLY,
}
