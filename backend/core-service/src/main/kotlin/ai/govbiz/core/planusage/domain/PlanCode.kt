package ai.govbiz.core.planusage.domain

/**
 * 계정 요금제입니다. 결제 연동 전이라 모든 회원은 FREE에서 시작하고,
 * 운영자가 `account_plan`에 배정한 계정만 다른 요금제를 씁니다.
 */
enum class PlanCode {
    FREE,
    PLUS,
    PREMIUM,
}
