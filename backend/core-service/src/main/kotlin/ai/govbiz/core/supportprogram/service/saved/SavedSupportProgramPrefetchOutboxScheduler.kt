package ai.govbiz.core.supportprogram.service.saved

import ai.govbiz.core.supportprogram.client.SavedSupportProgramPrefetchQueueClient
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/**
 * 발행 대기 중인 관심 공고 원문 선수집 작업을 큐에 재발행합니다. 큐에 실렸으나 오래 소비되지 않은 행은 다시 대기로 돌리고,
 * 준비된 지 하루가 지난 행은 신선도 갱신을 위해 다시 대기로 돌립니다.
 */
@Component
@ConditionalOnProperty(prefix = "app.assistant", name = ["prefetch-queue-enabled"], havingValue = "true")
class SavedSupportProgramPrefetchOutboxScheduler(
    private val repository: SavedSupportProgramRepository,
    private val client: SavedSupportProgramPrefetchQueueClient,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(fixedDelayString = "PT10S", initialDelayString = "PT10S", scheduler = "savedSupportProgramPrefetchOutboxTaskScheduler")
    fun publishPending() {
        try {
            repository.expireStalePrefetch()
            for (id in repository.publishablePrefetch()) {
                if (!repository.reservePrefetchPublication(id)) continue
                try {
                    client.publish(id)
                    repository.markPrefetchPublished(id)
                } catch (_: Exception) {
                    log.warn("Saved program prefetch publication unconfirmed; savedId={}; retained for retry", id)
                    break
                }
            }
        } catch (_: Exception) {
            log.warn("Saved program prefetch outbox scan failed; pending jobs remain in MySQL")
        }
    }
}
