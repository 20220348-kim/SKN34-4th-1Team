package ai.govbiz.core.combinationreview.service

import ai.govbiz.core.combinationreview.client.CombinationReviewQueueClient
import ai.govbiz.core.combinationreview.repository.CombinationReviewRunRepository
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/** 미실행 작업만 1분 간격으로 재발행한다. 모델 호출 재시도와 발행 재시도는 별개다. */
@Component
@ConditionalOnProperty(prefix = "app.combination-review.queue", name = ["enabled"], havingValue = "true")
class CombinationReviewOutboxScheduler(private val repository: CombinationReviewRunRepository, private val client: CombinationReviewQueueClient) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(fixedDelayString = "PT5S", initialDelayString = "PT5S", scheduler = "combinationReviewOutboxTaskScheduler")
    fun publishPending() {
        try {
            repository.expireStaleWork()
            for (id in repository.publishable()) {
                if (!repository.reservePublication(id)) continue
                try {
                    client.publish(id)
                    repository.markPublished(id)
                } catch (_: Exception) {
                    log.warn("Combination review publication unconfirmed; jobId={}; retained for retry", id)
                    break
                }
            }
        } catch (_: Exception) {
            log.warn("Combination review outbox scan failed; pending jobs remain in MySQL")
        }
    }
}
