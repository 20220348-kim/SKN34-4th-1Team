package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentGenerationJobRepository
import java.util.concurrent.Semaphore
import java.util.concurrent.ThreadPoolExecutor
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/**
 * QUEUED 작업을 MySQL에서 직접 집어 실행한다. 별도 큐 없이 여러 Core 인스턴스가 같은 표를 보며,
 * claim이 UPDATE 한 번으로 성공한 인스턴스만 그 작업을 실행한다. 만료 처리도 같은 주기에 한다.
 */
@Component
@ConditionalOnProperty(name = ["app.application-document.jobs.enabled"], havingValue = "true", matchIfMissing = true)
class ApplicationDocumentGenerationJobWorker(
    private val repository: ApplicationDocumentGenerationJobRepository,
    private val service: ApplicationDocumentGenerationJobService,
    @param:Qualifier("applicationDocumentGenerationExecutor") private val executor: ThreadPoolExecutor,
    @param:Value("\${app.application-document.jobs.concurrency:2}") private val concurrency: Int,
    @param:Value("\${app.application-document.unknown-outcome-lock-ttl:PT24H}") private val unknownOutcomeTtl: java.time.Duration,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val slots = Semaphore(concurrency)

    @Scheduled(fixedDelayString = "\${app.application-document.jobs.poll-ms:2000}", initialDelayString = "PT5S",
        scheduler = "applicationDocumentGenerationTaskScheduler")
    fun poll() {
        try {
            repository.expireStaleWork(unknownOutcomeTtl)
            for (id in repository.claimable(slots.availablePermits())) {
                if (!slots.tryAcquire()) break
                executor.execute {
                    try {
                        if (!service.execute(id)) log.info("application_document_generation_deferred jobId={} reason=BUSY", id)
                    } catch (error: Exception) {
                        log.error("application_document_generation_unrecorded jobId={}", id, error)
                    } finally {
                        slots.release()
                    }
                }
            }
        } catch (error: Exception) {
            log.warn("application_document_generation_poll_failed message={}", error.message?.take(300))
        }
    }
}
