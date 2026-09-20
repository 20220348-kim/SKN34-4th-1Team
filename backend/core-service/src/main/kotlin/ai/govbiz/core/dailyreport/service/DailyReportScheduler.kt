package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import ai.govbiz.core.dailyreport.config.DailyReportQueueProperties
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import java.time.Clock
import java.time.LocalDate
import java.time.LocalTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
@EnableScheduling
@ConditionalOnProperty(prefix = "app.daily-report", name = ["enabled"], havingValue = "true")
class DailyReportScheduler(
    private val reports: DailyReportService, private val repository: DailyReportRepository,
    private val accounts: AccountRepository, private val mail: DailyReportMailClient,
    private val properties: DailyReportProperties, @param:Qualifier("seoulClock") private val clock: Clock,
    private val queue: DailyReportQueueProperties,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** 오전 발송시각 이후 재시작한 서버도 같은 날 이어서 처리하되, DB 일별 예산과 발송 예약을 공유한다. */
    @Scheduled(fixedDelayString = "PT5M", initialDelayString = "PT1M", scheduler = "dailyReportTaskScheduler")
    fun run() {
        repository.expireStaleWork()
        if (!queue.enabled) {
            log.warn("Scheduled daily report generation requires app.daily-report.queue.enabled=true")
            return
        }
        if (!mail.isAvailable() || LocalTime.now(clock).hour < properties.sendHour) return
        val runDate = LocalDate.now(clock)
        val due = repository.dueAccountIds(runDate, properties.maxAccountsPerRun + 1, includeQueuedDeliveries = !queue.deliveryEnabled)
        if (due.size > properties.maxAccountsPerRun) log.info("Daily report backlog remains after bounded batch")
        for (id in due.take(properties.maxAccountsPerRun)) {
            if (LocalDate.now(clock) != runDate || LocalTime.now(clock).hour < properties.sendHour) break
            val account = accounts.findById(id)?.takeUnless { it.isSuspended } ?: continue
            try {
                val report = reports.enqueueScheduled(account)
                if (LocalDate.now(clock) != runDate) break
                if (queue.deliveryEnabled) repository.enqueueDelivery(report.id) else reports.deliver(report)
            } catch (error: DailyReportException) {
                log.warn("Daily report batch paused or skipped; code={}", error.code)
                if (error.code in setOf(DailyReportErrorCode.REPORT_DAILY_BUDGET_EXCEEDED, DailyReportErrorCode.REPORT_CAPACITY_EXCEEDED,
                        DailyReportErrorCode.SEARCH_NOT_READY)) break
            } catch (_: Exception) {
                log.warn("Daily report scheduled account failed")
            }
        }
    }
}
