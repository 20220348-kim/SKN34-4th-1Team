package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.dailyreport.client.DailyReportQueueClient
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/** 미실행 작업만 1분 간격으로 재발행한다. 모델 호출 재시도와 발행 재시도는 별개다. */
@Component
@ConditionalOnProperty(prefix = "app.daily-report.queue", name = ["enabled"], havingValue = "true")
class DailyReportOutboxScheduler(private val repository: DailyReportRepository, private val client: DailyReportQueueClient) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(fixedDelayString = "PT5S", initialDelayString = "PT5S", scheduler = "dailyReportOutboxTaskScheduler")
    fun publishPending() {
        try {
            repository.expireStaleWork()
            for (id in repository.publishableJobs()) {
                if (!repository.reserveJobPublication(id)) continue
                try {
                    client.publish(id)
                    repository.markJobPublished(id)
                } catch (_: Exception) {
                    log.warn("Daily report publication unconfirmed; jobId={}; retained for retry", id)
                    break
                }
            }
        } catch (_: Exception) {
            log.warn("Daily report outbox scan failed; pending jobs remain in MySQL")
        }
    }
}
