package ai.govbiz.core.notification.domain

/**
 * 관심 공고 마감 알림 설정입니다. 켜려면 이메일·앱 알림 중 하나 이상을 골라야 하며, 신청 마감 [REMINDER_DAYS_BEFORE]일 전마다
 * 한 번씩 알립니다. 저장한 적이 없는 계정은 [DEFAULT](꺼짐)를 씁니다.
 */
data class DeadlineReminderSetting(val enabled: Boolean, val email: Boolean, val push: Boolean) {
    init {
        require(!enabled || email || push) { "an enabled deadline reminder needs at least one channel" }
    }

    companion object {
        /** 마감 며칠 전에 알릴지입니다. 같은 공고·마감일에도 일수마다 한 번씩 보냅니다. */
        val REMINDER_DAYS_BEFORE = listOf(7, 3, 1)
        val DEFAULT = DeadlineReminderSetting(enabled = false, email = false, push = false)
    }
}
