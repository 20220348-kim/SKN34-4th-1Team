package ai.govbiz.core.notification.domain

/**
 * 관심 공고 마감 알림 설정입니다. 켜려면 이메일·앱 알림 중 하나 이상을 골라야 하며, 신청 마감 [daysBefore]일 전에 한 번 알립니다.
 * 저장한 적이 없는 계정은 [DEFAULT](꺼짐, 3일 전)를 씁니다.
 */
data class DeadlineReminderSetting(val enabled: Boolean, val daysBefore: Int, val email: Boolean, val push: Boolean) {
    init {
        require(daysBefore in DAYS_BEFORE_RANGE) { "daysBefore must be 1..7" }
        require(!enabled || email || push) { "an enabled deadline reminder needs at least one channel" }
    }

    companion object {
        val DAYS_BEFORE_RANGE = 1..7
        val DEFAULT = DeadlineReminderSetting(enabled = false, daysBefore = 3, email = false, push = false)
    }
}
