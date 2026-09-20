package ai.govbiz.catalog.supportprogram.service.sync

import ai.govbiz.catalog.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.catalog.supportprogram.repository.SupportProgramRepository
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/** 충청남도 온라인수출지원시스템의 전체 수집·색인 성공 후 그 제공처 스냅샷만 공개합니다. */
@Service
class CnTradeNoticeSupportProgramCatalogSyncService(
    @param:Qualifier("cnTradeNoticeSupportProgramCatalogFacade") private val catalogFacade: SupportProgramCatalogFacade,
    private val repository: SupportProgramRepository,
    private val indexSyncService: SupportProgramIndexSyncService,
) {
    fun sync(): Int? {
        val generation = repository.startSyncGeneration("CNTRADE_NOTICE")
        try {
            val programs = catalogFacade.load()
            indexSyncService.indexSnapshot(programs)
            if (!repository.publishSnapshotIfCurrent("CNTRADE_NOTICE", programs, generation)) return null
            return programs.size
        } catch (exception: RuntimeException) {
            try {
                repository.recordSyncFailureIfCurrent("CNTRADE_NOTICE", generation)
            } catch (recordingException: RuntimeException) {
                if (recordingException !== exception) exception.addSuppressed(recordingException)
            }
            throw exception
        }
    }
}
