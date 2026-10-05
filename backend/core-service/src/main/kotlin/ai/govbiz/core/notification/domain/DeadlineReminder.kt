package ai.govbiz.core.notification.domain

import java.time.LocalDate

/**
 * 마감 알림 채널 하나의 발송 상태입니다. 채널을 고르지 않았으면 NOT_REQUESTED입니다.
 * SENT는 SMTP·Expo가 접수했다는 뜻이며 받은 편지함·기기 표시를 보장하지 않습니다. UNKNOWN은 자동으로 다시 보내지 않습니다.
 */
enum class DeadlineReminderStatus { NOT_REQUESTED, PENDING, SENDING, SENT, FAILED, UNKNOWN, SKIPPED }

enum class DeadlineReminderChannel { EMAIL, PUSH }

/** 예약된 마감 알림 한 건입니다. [dueDate]는 예약할 때의 공고 신청 마감일이며 같은 마감일의 알림은 한 번만 예약합니다. */
data class DeadlineReminder(
    val id: Long,
    val accountId: Long,
    val sourceCode: String,
    val sourceProgramId: String,
    val dueDate: LocalDate,
    val emailStatus: DeadlineReminderStatus,
    val pushStatus: DeadlineReminderStatus,
) {
    fun status(channel: DeadlineReminderChannel) = when (channel) {
        DeadlineReminderChannel.EMAIL -> emailStatus
        DeadlineReminderChannel.PUSH -> pushStatus
    }
}

/** 채널 하나의 최종 결과입니다. [errorCode]에는 외부 원문이 아닌 안정적인 코드만 담습니다. */
data class DeadlineReminderOutcome(val status: DeadlineReminderStatus, val errorCode: String? = null) {
    init {
        require(status in FINAL_STATUSES) { "deadline reminder outcome must be final" }
        require(errorCode == null || ERROR_CODE.matches(errorCode)) { "error code must be a short stable code" }
    }

    companion object {
        private val FINAL_STATUSES = setOf(
            DeadlineReminderStatus.SENT, DeadlineReminderStatus.FAILED, DeadlineReminderStatus.UNKNOWN, DeadlineReminderStatus.SKIPPED,
        )
        private val ERROR_CODE = Regex("[A-Za-z]{1,100}")

        val SENT = DeadlineReminderOutcome(DeadlineReminderStatus.SENT)
        fun skipped(reason: String) = DeadlineReminderOutcome(DeadlineReminderStatus.SKIPPED, reason)
        fun unknown() = DeadlineReminderOutcome(DeadlineReminderStatus.UNKNOWN, "SendUnconfirmed")
        fun failed(code: String) = DeadlineReminderOutcome(DeadlineReminderStatus.FAILED, code)
    }
}
