package ai.govbiz.core.supportprogram.service.sync

import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
@ConditionalOnProperty(prefix = "app.support-program-index", name = ["enabled"], havingValue = "true", matchIfMissing = true)
@ai.govbiz.core.supportprogram.service.projection.config.EmbeddedCatalogOnly
class SupportProgramIndexSyncScheduler(private val syncService: SupportProgramIndexSyncService) {
    @Scheduled(
        initialDelayString = "\${app.support-program-index.initial-delay}",
        fixedDelayString = "\${app.support-program-index.fixed-delay}",
        scheduler = "supportProgramIndexTaskScheduler",
    )
    fun synchronize() {
        try {
            val count = syncService.repair()
            logger.info("지원사업 {}건의 누락 벡터 색인을 복구했습니다.", count)
        } catch (exception: RuntimeException) {
            logger.error("지원사업 벡터 색인 복구 실패: {}. 다음 실행에서 다시 시도합니다.", exception.javaClass.simpleName)
        }
    }

    private companion object {
        val logger = LoggerFactory.getLogger(SupportProgramIndexSyncScheduler::class.java)
    }
}
