package ai.govbiz.catalog.supportprogram.service.sync

import ai.govbiz.catalog.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.catalog.supportprogram.repository.SupportProgramRepository
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/** 전체 수집·검증·색인이 성공한 경우에만 MSIT 제공처 스냅샷을 공개합니다. */
@Service
class MsitSupportProgramCatalogSyncService(
    @param:Qualifier("msitSupportProgramCatalogFacade") private val catalogFacade: SupportProgramCatalogFacade,
    private val repository: SupportProgramRepository,
    private val indexSyncService: SupportProgramIndexSyncService,
) {
    fun sync(): Int? {
        val generation = repository.startSyncGeneration("MSIT")
        try {
            val programs = catalogFacade.load()
            indexSyncService.indexSnapshot(programs)
            if (!repository.publishSnapshotIfCurrent("MSIT", programs, generation)) return null
            return programs.size
        } catch (exception: RuntimeException) {
            try {
                repository.recordSyncFailureIfCurrent("MSIT", generation)
            } catch (recordingException: RuntimeException) {
                if (recordingException !== exception) exception.addSuppressed(recordingException)
            }
            throw exception
        }
    }
}
