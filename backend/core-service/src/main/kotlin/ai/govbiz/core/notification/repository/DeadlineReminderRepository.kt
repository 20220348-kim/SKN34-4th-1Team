package ai.govbiz.core.notification.repository

import ai.govbiz.core.notification.domain.DeadlineReminder
import ai.govbiz.core.notification.domain.DeadlineReminderChannel
import ai.govbiz.core.notification.domain.DeadlineReminderOutcome
import ai.govbiz.core.notification.domain.DeadlineReminderStatus
import ai.govbiz.core.notification.repository.mapper.DeadlineReminderDbRow
import ai.govbiz.core.notification.repository.mapper.DeadlineReminderMapper
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/**
 * 마감 알림 발송 기록을 저장합니다. 예약·선점·결과 저장은 각각 짧은 단일 SQL이며 메일·푸시 호출은 이 Repository 밖에서 합니다.
 * 오늘(서울) 예약한 알림만 선점할 수 있어 날짜가 바뀐 뒤 지난 D-N 알림을 늦게 보내지 않습니다.
 */
@Repository
class DeadlineReminderRepository(
    private val mapper: DeadlineReminderMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun reserveDue(today: LocalDate): Int = mapper.reserveDue(today, now())

    fun dispatchable(limit: Int): List<DeadlineReminder> = mapper.findDispatchable(todayStart(), limit).map { it.toDomain() }

    fun claim(id: Long, channel: DeadlineReminderChannel): Boolean = when (channel) {
        DeadlineReminderChannel.EMAIL -> mapper.claimEmail(id, todayStart(), now())
        DeadlineReminderChannel.PUSH -> mapper.claimPush(id, todayStart(), now())
    } == 1

    fun finish(id: Long, channel: DeadlineReminderChannel, outcome: DeadlineReminderOutcome) {
        val updated = when (channel) {
            DeadlineReminderChannel.EMAIL -> mapper.finishEmail(id, outcome.status.name, outcome.errorCode, now())
            DeadlineReminderChannel.PUSH -> mapper.finishPush(id, outcome.status.name, outcome.errorCode, now())
        }
        check(updated == 1) { "deadline reminder channel was not in SENDING" }
    }

    /** 지난 날짜에 보내지 못한 채널은 SKIPPED, 20분 넘게 결과가 없는 발송은 UNKNOWN으로 끝냅니다. 다시 보내지 않습니다. */
    @Transactional
    fun expire() {
        val now = now()
        mapper.expireEmail(todayStart(), now.minusMinutes(SENDING_MINUTES), now)
        mapper.expirePush(todayStart(), now.minusMinutes(SENDING_MINUTES), now)
    }

    private fun DeadlineReminderDbRow.toDomain() = DeadlineReminder(
        id, accountId, sourceCode, sourceProgramId, requireNotNull(dueDate) { "deadline reminder dueDate must not be null" },
        DeadlineReminderStatus.valueOf(emailStatus), DeadlineReminderStatus.valueOf(pushStatus),
    )

    private fun now() = LocalDateTime.now(clock)
    private fun todayStart() = LocalDate.now(clock).atStartOfDay()

    private companion object {
        const val SENDING_MINUTES = 20L
    }
}
