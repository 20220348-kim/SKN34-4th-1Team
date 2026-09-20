package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.client.ApplicationFormDiscoveryQueueClient
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormDiscoveryJobRepository
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/** 미실행 작업만 1분 간격으로 재발행한다. 모델 호출 재시도와 발행 재시도는 별개다. */
@Component
@ConditionalOnProperty(prefix = "app.application-form-discovery.queue", name = ["enabled"], havingValue = "true")
class ApplicationFormDiscoveryOutboxScheduler(private val repository: ApplicationFormDiscoveryJobRepository, private val client: ApplicationFormDiscoveryQueueClient) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(fixedDelayString = "PT5S", initialDelayString = "PT5S", scheduler = "applicationFormDiscoveryOutboxTaskScheduler")
    fun publishPending() {
        try {
            repository.expireStaleWork()
            for (id in repository.publishable()) {
                if (!repository.reservePublication(id)) continue
                try {
                    client.publish(id)
                    repository.markPublished(id)
                } catch (_: Exception) {
                    log.warn("Application form discovery publication unconfirmed; jobId={}; retained for retry", id)
                    break
                }
            }
        } catch (_: Exception) {
            log.warn("Application form discovery outbox scan failed; pending jobs remain in MySQL")
        }
    }
}
