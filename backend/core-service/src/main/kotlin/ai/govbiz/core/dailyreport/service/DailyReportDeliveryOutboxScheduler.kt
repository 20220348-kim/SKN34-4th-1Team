package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.dailyreport.client.DailyReportDeliveryQueueClient
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/** 미발송 리포트 ID만 재발행한다. SMTP 시도 이후 UNKNOWN은 재발행하지 않는다. */
@Component
@ConditionalOnProperty(prefix = "app.daily-report.queue", name = ["delivery-enabled"], havingValue = "true")
class DailyReportDeliveryOutboxScheduler(private val repository: DailyReportRepository, private val client: DailyReportDeliveryQueueClient) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(fixedDelayString = "PT5S", initialDelayString = "PT5S", scheduler = "dailyReportDeliveryOutboxTaskScheduler")
    fun publishPending() {
        try {
            repository.expireStaleWork()
            for (id in repository.publishableDeliveries()) {
                if (!repository.reserveDeliveryPublication(id)) continue
                try {
                    client.publish(id)
                    repository.markDeliveryPublished(id)
                } catch (_: Exception) {
                    log.warn("Daily report delivery publication unconfirmed; reportId={}; retained for retry", id)
                    break
                }
            }
        } catch (_: Exception) {
            log.warn("Daily report delivery outbox scan failed; pending jobs remain in MySQL")
        }
    }
}
