package ai.govbiz.core.assistant.service

import ai.govbiz.core.assistant.client.dto.AiAssistantChunkRef
import ai.govbiz.core.assistant.client.dto.AiAssistantSavedProgramDocument
import ai.govbiz.core.assistant.config.AssistantAgentProperties
import ai.govbiz.core.supportprogram.domain.SavedSupportProgram
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceChunk
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.saved.SavedSupportProgramService
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/**
 * 관심 공고 묶음 질문의 두 번째 에이전트 호출에 실을 원문 청크 허용 목록을 만듭니다.
 * 관심 공고 최대 [MAX_DOCUMENTS]건의 원문을 확보(저장된 최신 원문 재사용, 없으면 지금 수집)·청킹·색인하며,
 * 전체 예산(`app.assistant.document-prepare-timeout`) 안에 끝나지 않은 공고는 청크 없이("원문 미확인") 보냅니다.
 */
@Service
class AssistantSavedProgramDocumentService(
    private val savedSupportProgramService: SavedSupportProgramService,
    private val evidenceService: SupportProgramEvidenceService,
    private val evidenceFacade: AiSupportProgramEvidenceFacade,
    private val properties: AssistantAgentProperties,
    @param:Qualifier("assistantDocumentExecutor") private val executor: ExecutorService,
) {
    /** 준비된 문서와, 인용 대조에 쓸 문서별 청크 원문입니다. */
    data class PreparedDocuments(
        val documents: List<AiAssistantSavedProgramDocument>,
        val chunkTexts: Map<String, List<String>>,
    )

    fun prepare(accountId: Long): PreparedDocuments {
        val saved = savedSupportProgramService.list(accountId).take(MAX_DOCUMENTS)
        if (saved.isEmpty()) return PreparedDocuments(emptyList(), emptyMap())
        val started = System.nanoTime()
        val tasks = saved.map { item -> Callable { prepareOne(item) } }
        val futures = executor.invokeAll(tasks, properties.documentPrepareTimeout.toMillis(), TimeUnit.MILLISECONDS)
        val chunkTexts = mutableMapOf<String, List<String>>()
        val documents = saved.zip(futures).map { (item, future) ->
            val chunks = try {
                if (future.isCancelled) null else future.get()
            } catch (_: Exception) {
                null
            }
            val program = item.program
            if (chunks != null) chunkTexts[program.sourceQualifiedId] = chunks.map(SupportProgramEvidenceChunk::text)
            AiAssistantSavedProgramDocument(
                sourceCode = program.sourceCode,
                sourceProgramId = program.id,
                title = program.title.take(TITLE_MAX),
                applicationEndDate = program.applicationEndDate?.toString(),
                documentId = program.sourceQualifiedId,
                chunks = chunks?.map { AiAssistantChunkRef(it.id, it.contentHash) } ?: emptyList(),
            )
        }
        logger.info(
            "assistant_saved_program_documents_prepared account_present=true document_count={} fetched_count={} elapsed_ms={}",
            documents.size, chunkTexts.size, (System.nanoTime() - started) / 1_000_000,
        )
        return PreparedDocuments(documents, chunkTexts)
    }

    /** 한 공고의 원문을 확보해 청킹하고 AI Service에 색인합니다. 실패는 호출부가 '원문 미확인'으로 다룹니다. */
    private fun prepareOne(item: SavedSupportProgram): List<SupportProgramEvidenceChunk>? = try {
        val chunks = evidenceService.prepareChunks(item.program)
        evidenceFacade.index(chunks)
        chunks
    } catch (_: Exception) {
        // 공고 종류·수집 실패·색인 실패 어느 것이든 그 공고만 빠진다. 원문·오류 본문은 남기지 않는다.
        logger.info("assistant_saved_program_document_unavailable document_id={}", item.program.sourceQualifiedId)
        null
    }

    companion object {
        const val MAX_DOCUMENTS = 10
        const val TITLE_MAX = 160
        private val logger = LoggerFactory.getLogger(AssistantSavedProgramDocumentService::class.java)
    }
}
