package ai.govbiz.core.supportprogram.service.sync

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/** 완전한 공고 공개와 시스템 분석 등록을 묶는 짧은 업무 transaction. 외부 I/O는 호출 전에 끝낸다. */
@Service
@ai.govbiz.core.supportprogram.service.projection.config.EmbeddedCatalogOnly
class SupportProgramCatalogPublicationService(
    private val programs: SupportProgramRepository,
    private val availability: ApplicationFormAvailabilityRepository,
) {
    @Transactional
    fun publish(sourceCode: String, snapshot: List<CatalogSupportProgram>, generation: Long): Boolean {
        if (!programs.publishSnapshotIfCurrent(sourceCode, snapshot, generation)) return false
        snapshot.forEach { item -> availability.register(sourceCode, item.program.id,
            SupportProgramCatalogFingerprintHelper.calculate(listOf(item))) }
        return true
    }
}
