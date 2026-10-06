package ai.govbiz.core.notification.repository.mapper

import java.time.LocalDate
import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** MyBatis가 마감 알림 발송 기록 한 행을 읽기 위한 DB 행 값입니다. */
data class DeadlineReminderDbRow(
    var id: Long = 0,
    var accountId: Long = 0,
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var dueDate: LocalDate? = null,
    var emailStatus: String = "",
    var pushStatus: String = "",
)

/**
 * 마감 알림 발송 기록(`deadline_reminder`) SQL을 실행하는 MyBatis Mapper입니다.
 * 채널별 선점은 PENDING → SENDING, 결과 저장은 SENDING에서만 바꾸는 조건부 UPDATE이며 바뀐 행 수를 돌려줍니다.
 */
@Mapper
interface DeadlineReminderMapper {
    /** 오늘로부터 [daysBefore]의 일수 뒤가 신청 마감일인 관심 공고를 일수마다 한 번만 예약합니다. */
    fun reserveDue(@Param("today") today: LocalDate, @Param("daysBefore") daysBefore: List<Int>, @Param("now") now: LocalDateTime): Int

    /** [since] 이후 예약했고 아직 보내지 않은 채널이 있는 알림(오래된 순)입니다. */
    fun findDispatchable(@Param("since") since: LocalDateTime, @Param("limit") limit: Int): List<DeadlineReminderDbRow>

    fun claimEmail(@Param("id") id: Long, @Param("since") since: LocalDateTime, @Param("now") now: LocalDateTime): Int

    fun claimPush(@Param("id") id: Long, @Param("since") since: LocalDateTime, @Param("now") now: LocalDateTime): Int

    fun finishEmail(
        @Param("id") id: Long, @Param("status") status: String, @Param("error") error: String?, @Param("now") now: LocalDateTime,
    ): Int

    fun finishPush(
        @Param("id") id: Long, @Param("status") status: String, @Param("error") error: String?, @Param("now") now: LocalDateTime,
    ): Int

    /** 지난 날짜의 PENDING은 SKIPPED, 오래 끝나지 않은 SENDING은 UNKNOWN으로 끝냅니다. */
    fun expireEmail(
        @Param("since") since: LocalDateTime, @Param("sendingBefore") sendingBefore: LocalDateTime, @Param("now") now: LocalDateTime,
    ): Int

    fun expirePush(
        @Param("since") since: LocalDateTime, @Param("sendingBefore") sendingBefore: LocalDateTime, @Param("now") now: LocalDateTime,
    ): Int
}
