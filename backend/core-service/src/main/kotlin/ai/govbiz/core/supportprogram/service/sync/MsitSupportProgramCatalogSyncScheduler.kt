package ai.govbiz.core.supportprogram.service.sync

import ai.govbiz.core.supportprogram.facade.exception.SupportProgramCatalogFacadeException
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
@ConditionalOnProperty(prefix = "app.msit.sync", name = ["enabled"], havingValue = "true", matchIfMissing = false)
@ai.govbiz.core.supportprogram.service.projection.config.EmbeddedCatalogOnly
class MsitSupportProgramCatalogSyncScheduler(private val syncService: MsitSupportProgramCatalogSyncService) {
    @Scheduled(
        initialDelayString = "\${app.msit.sync.initial-delay:15s}",
        fixedDelayString = "\${app.msit.sync.fixed-delay:6h}",
        scheduler = "msitCatalogTaskScheduler",
    )
    fun synchronize() {
        try {
            val count = syncService.sync()
            if (count == null) logger.info("더 최근 MSIT 동기화가 있어 스냅샷 공개를 건너뜁니다.")
            else logger.info("MSIT 사업공고 {}건을 MySQL과 검색 색인에 동기화했습니다.", count)
        } catch (exception: SupportProgramCatalogFacadeException) {
            logger.error("MSIT 공고 수집에 실패했습니다. 실패 유형: {}. 기존 공개 공고는 유지합니다.", exception.failure)
        } catch (exception: RuntimeException) {
            logger.error("MSIT 공고 동기화에 실패했습니다. 오류 유형: {}. 기존 공개 공고는 유지합니다.", exception.javaClass.simpleName)
        }
    }

    private companion object {
        val logger = LoggerFactory.getLogger(MsitSupportProgramCatalogSyncScheduler::class.java)
    }
}
