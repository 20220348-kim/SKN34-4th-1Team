package ai.govbiz.core.planusage.domain

/**
 * 계정 요금제와 기능별 한도입니다. 결제 연동 전이라 모든 회원은 FREE에서 시작하고,
 * 운영자가 `account_plan`에 배정한 계정만 다른 요금제를 씁니다.
 * 한도가 null이면 아직 정하지 않아 제한하지 않습니다. PLUS·PREMIUM은 숫자를 정하면 여기만 바꾸면 적용됩니다.
 */
enum class PlanCode(
    private val aiSearchPerDay: Int?,
    private val evidenceQuestionsPerDay: Int?,
) {
    FREE(aiSearchPerDay = 10, evidenceQuestionsPerDay = 10),
    PLUS(aiSearchPerDay = null, evidenceQuestionsPerDay = null),
    PREMIUM(aiSearchPerDay = null, evidenceQuestionsPerDay = null),
    ;

    /** 이 요금제의 기능별 한도입니다. null이면 제한하지 않습니다. */
    fun limitOf(feature: PlanUsageFeature): Int? = when (feature) {
        PlanUsageFeature.AI_SEARCH -> aiSearchPerDay
        PlanUsageFeature.EVIDENCE_QUESTION -> evidenceQuestionsPerDay
    }

    companion object {
        /** 로그인하지 않은 접속 주소가 하루에 쓸 수 있는 AI 대화 검색 횟수입니다. 다른 AI 기능은 로그인해야 씁니다. */
        const val GUEST_AI_SEARCH_PER_DAY = 2
    }
}
