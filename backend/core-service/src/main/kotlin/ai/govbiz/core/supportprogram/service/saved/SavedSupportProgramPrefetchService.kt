package ai.govbiz.core.supportprogram.service.saved

import ai.govbiz.core.supportprogram.domain.SavedSupportProgramPrefetchStatus
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceNotSupportedException
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

/**
 * 관심 공고 원문 선수집입니다. 큐에서 받은 관심 공고 행의 공고 원문을 확보·청킹·색인해 두어
 * 도우미 관심 공고 질문의 첫 응답이 수집을 기다리지 않게 합니다. 결과는 DONE(준비됨)·FAILED(수집 불가)로 남깁니다.
 */
@Service
class SavedSupportProgramPrefetchService(
    private val repository: SavedSupportProgramRepository,
    private val evidenceService: SupportProgramEvidenceService,
    private val evidenceFacade: AiSupportProgramEvidenceFacade,
) {
    /** 큐에 실린 행 하나를 처리합니다. 행이 이미 삭제됐거나 발행 상태가 아니면 아무것도 하지 않습니다. */
    fun prefetch(savedId: Long) {
        val program = repository.findPublishedProgram(savedId) ?: return
        val status = try {
            evidenceFacade.index(evidenceService.prepareChunks(program))
            SavedSupportProgramPrefetchStatus.DONE
        } catch (_: SupportProgramEvidenceNotSupportedException) {
            // 기업마당 외 공고는 원문 근거를 지원하지 않는다. 다시 시도해도 같으므로 실패로 닫는다.
            SavedSupportProgramPrefetchStatus.FAILED
        }
        repository.finishPrefetch(savedId, status)
        log.info("saved_support_program_prefetch_finished saved_id={} status={}", savedId, status)
    }

    private companion object {
        val log = LoggerFactory.getLogger(SavedSupportProgramPrefetchService::class.java)
    }
}
