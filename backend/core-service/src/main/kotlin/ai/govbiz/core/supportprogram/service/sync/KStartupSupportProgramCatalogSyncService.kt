package ai.govbiz.core.supportprogram.service.sync

import ai.govbiz.core.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/** 선택한 K-Startup 범위의 전체 수집·색인 성공 후 그 제공처 스냅샷만 공개합니다. */
@Service
@ai.govbiz.core.supportprogram.service.projection.config.EmbeddedCatalogOnly
class KStartupSupportProgramCatalogSyncService(
    @param:Qualifier("kStartupSupportProgramCatalogFacade") private val catalogFacade: SupportProgramCatalogFacade,
    private val repository: SupportProgramRepository,
    private val indexSyncService: SupportProgramIndexSyncService,
    private val publicationService: SupportProgramCatalogPublicationService,
) {
    fun sync(): Int? {
        val generation = repository.startSyncGeneration("KSTARTUP")
        try {
            val programs = catalogFacade.load()
            indexSyncService.indexSnapshot(programs)
            if (!publicationService.publish("KSTARTUP", programs, generation)) return null
            return programs.size
        } catch (exception: RuntimeException) {
            try {
                repository.recordSyncFailureIfCurrent("KSTARTUP", generation)
            } catch (recordingException: RuntimeException) {
                if (recordingException !== exception) exception.addSuppressed(recordingException)
            }
            throw exception
        }
    }
}
