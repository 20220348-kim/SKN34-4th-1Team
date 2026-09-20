package ai.govbiz.catalog.supportprogram.service.sync

import ai.govbiz.catalog.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.catalog.supportprogram.repository.SupportProgramRepository
import org.springframework.beans.factory.annotation.Qualifier
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

/**
 * 기업마당 공고 전체의 벡터를 먼저 준비한 뒤, 검색 가능한 MySQL 스냅샷을 한 번에 공개합니다.
 */
@Service
class BizInfoSupportProgramCatalogSyncService(
    @param:Qualifier("bizInfoSupportProgramCatalogFacade") private val catalogFacade: SupportProgramCatalogFacade,
    private val supportProgramRepository: SupportProgramRepository,
    private val indexSyncService: SupportProgramIndexSyncService,
) {
    /** 최신 실행에 의해 대체된 경우 null, 공개한 공고 수는 0 이상으로 반환합니다. */
    fun sync(): Int? {
        val generation = supportProgramRepository.startSyncGeneration("BIZINFO")
        try {
            val programs = catalogFacade.load()
            indexSyncService.indexSnapshot(programs)
            if (!supportProgramRepository.publishSnapshotIfCurrent("BIZINFO", programs, generation)) {
                logger.info("더 최근에 시작된 기업마당 동기화가 있어 이전 스냅샷 공개를 건너뜁니다.")
                return null
            }

            return programs.size
        } catch (exception: RuntimeException) {
            try {
                supportProgramRepository.recordSyncFailureIfCurrent("BIZINFO", generation)
            } catch (recordingException: RuntimeException) {
                exception.addSuppressed(recordingException)
            }
            throw exception
        }
    }

    private companion object {
        val logger = LoggerFactory.getLogger(BizInfoSupportProgramCatalogSyncService::class.java)
    }
}
