package ai.govbiz.core.planusage.domain

/**
 * 출시 전 무료 체험입니다. 플러스·프리미엄을 요금제마다 계정당 한 번, [DAYS]일 동안 그 요금제의 이용권으로 씁니다.
 * 끝나면 무료로 돌아가고 결제 수단을 받지 않아 자동 결제가 없습니다. 운영자가 배정한 유료 요금제를 쓰는 동안과
 * 지금보다 낮거나 같은 요금제는 체험할 수 없습니다(플러스 체험 중 프리미엄 체험은 바로 바꿉니다).
 */
object PlanTrial {
    const val DAYS = 14L
    private val PLANS = listOf(PlanCode.PLUS, PlanCode.PREMIUM)

    /** [current]를 쓰는 계정이 지금 시작할 수 있는 체험입니다. [used]는 이미 체험한 적 있는 요금제입니다. */
    fun available(current: AccountPlan, used: Set<PlanCode>): List<PlanCode> {
        if (current.code != PlanCode.FREE && current.source == PlanSource.OPERATOR) return emptyList()
        return PLANS.filter { it !in used && it.ordinal > current.code.ordinal }
    }
}
