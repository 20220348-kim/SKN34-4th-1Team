package ai.govbiz.core.planusage.domain

import java.time.ZonedDateTime

/**
 * 계정에 배정한 요금제입니다. 유료 요금제는 [startsAt]부터 30일씩을 한 이용 기간으로 세고, [endsAt]이 지나면 무료로 돌아갑니다.
 * 30일 이용권은 [endsAt]이 시작 30일 뒤인 배정이고, [endsAt]이 없는 배정(운영자·검증 계정)은 30일마다 새 이용 기간이 시작됩니다.
 * [unlimited]는 로컬 개발용으로 지정한 계정이며, 사용량은 그 요금제의 기간으로 세지만 한도로 막지 않습니다.
 */
data class AccountPlan(
    val code: PlanCode,
    val startsAt: ZonedDateTime? = null,
    val endsAt: ZonedDateTime? = null,
    val unlimited: Boolean = false,
) {
    init {
        require(code == PlanCode.FREE || startsAt != null) { "A paid plan needs its start" }
        require(endsAt == null || (startsAt != null && endsAt.isAfter(startsAt))) { "A plan must end after it starts" }
    }

    /** [now]에 쓰는 요금제입니다. 시작 전이거나 끝난 유료 배정은 무료입니다. */
    fun effectiveAt(now: ZonedDateTime): AccountPlan {
        if (code == PlanCode.FREE) return FREE
        val started = !now.isBefore(requireNotNull(startsAt))
        val ended = endsAt != null && !now.isBefore(endsAt)
        return if (started && !ended) this else FREE
    }

    /** [feature]를 [now]에 세는 기간입니다. 무료는 기능마다 서울 하루·달이고, 유료는 이용 기간입니다. */
    fun windowOf(feature: PlanUsageFeature, now: ZonedDateTime): PlanUsageWindow =
        if (code == PlanCode.FREE) {
            PlanUsageWindow.current(feature.freePeriod, now)
        } else {
            PlanUsageWindow.plan(requireNotNull(startsAt), endsAt, now)
        }

    /** 이 계정이 [feature]를 한 기간에 쓸 수 있는 양입니다. 개발용 무제한 계정이면 null입니다. */
    fun limitOf(feature: PlanUsageFeature): Int? = if (unlimited) null else code.limitOf(feature)

    /** 같은 요금제·기간을 쓰되 한도로 막지 않는 개발용 무제한 계정으로 바꿉니다. */
    fun withoutLimits(): AccountPlan = copy(unlimited = true)

    companion object {
        val FREE = AccountPlan(PlanCode.FREE)
    }
}
