package ai.govbiz.core.planusage.domain

/**
 * 요금제와 기능별 한도입니다. 무료는 AI 대화 검색·원문 질문을 하루로, 신청 문서 초안·중복 검토를 서울 달력의 달로 셉니다.
 * 플러스·프리미엄은 30일 이용권이라 네 기능 모두 이용 기간(30일) 총량으로 셉니다. 결제 연동 전이라 운영자가 `account_plan`에
 * 배정한 계정만 유료 요금제를 씁니다. 유료 숫자는 출시 전 출발점이며 실제 사용량을 모아 고칩니다.
 */
enum class PlanCode(
    private val aiSearches: Int,
    private val evidenceQuestions: Int,
    private val applicationDrafts: Int,
    private val combinationReviews: Int,
) {
    FREE(aiSearches = 10, evidenceQuestions = 10, applicationDrafts = 3, combinationReviews = 3),
    PLUS(aiSearches = 500, evidenceQuestions = 500, applicationDrafts = 5, combinationReviews = 10),
    PREMIUM(aiSearches = 1500, evidenceQuestions = 1500, applicationDrafts = 20, combinationReviews = 40),
    ;

    /** 이 요금제가 [feature]를 한 기간에 쓸 수 있는 양입니다. 기간은 [AccountPlan.windowOf]가 정합니다. */
    fun limitOf(feature: PlanUsageFeature): Int = when (feature) {
        PlanUsageFeature.AI_SEARCH -> aiSearches
        PlanUsageFeature.EVIDENCE_QUESTION -> evidenceQuestions
        PlanUsageFeature.APPLICATION_DRAFT -> applicationDrafts
        PlanUsageFeature.COMBINATION_REVIEW -> combinationReviews
    }

    companion object {
        /** 로그인하지 않은 접속 주소가 하루에 쓸 수 있는 AI 대화 검색 횟수입니다. 다른 AI 기능은 로그인해야 씁니다. */
        const val GUEST_AI_SEARCH_PER_DAY = 2
    }
}
