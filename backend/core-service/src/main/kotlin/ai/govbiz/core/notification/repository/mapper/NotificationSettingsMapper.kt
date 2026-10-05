package ai.govbiz.core.notification.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** MyBatis가 계정 알림 설정 한 행을 읽기 위한 DB 행 값입니다. */
data class NotificationSettingsDbRow(
    var accountId: Long = 0,
    var deadlineReminderEnabled: Boolean = false,
    var deadlineReminderDaysBefore: Int = 3,
    var deadlineReminderEmail: Boolean = false,
    var deadlineReminderPush: Boolean = false,
)

/** 계정 알림 설정(`account_notification_setting`) SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface NotificationSettingsMapper {
    fun find(@Param("accountId") accountId: Long): NotificationSettingsDbRow?

    /** 없으면 만들고 있으면 바꿉니다. 이메일을 처음 고른 시각은 이메일 선택을 유지하는 동안 보존합니다. */
    fun upsert(
        @Param("accountId") accountId: Long,
        @Param("enabled") enabled: Boolean,
        @Param("daysBefore") daysBefore: Int,
        @Param("email") email: Boolean,
        @Param("push") push: Boolean,
        @Param("now") now: LocalDateTime,
    ): Int
}
