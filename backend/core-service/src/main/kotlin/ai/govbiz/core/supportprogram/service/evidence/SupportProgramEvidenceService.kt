package ai.govbiz.core.supportprogram.service.evidence

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.facade.BizInfoSupportProgramSourceDocumentFacade
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramSourceDocumentFacadeException
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerResult
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceNotSupportedException
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceUnavailableException
import java.time.Clock
import java.time.Duration
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
import org.slf4j.LoggerFactory

/** 특정 기업마당 공고의 공식 상세 원문을 근거로 질문에 답합니다. */
@Service
class SupportProgramEvidenceService(
    private val detailService: SupportProgramDetailService,
    private val repository: SupportProgramRepository,
    private val sourceDocumentFacade: BizInfoSupportProgramSourceDocumentFacade,
    private val aiEvidenceFacade: AiSupportProgramEvidenceFacade,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    private val chunkCacheLock = Any()
    private val chunkCache = LinkedHashMap<String, PreparedChunks>(16, 0.75f, true)

    fun answer(
        sourceCode: String,
        sourceProgramId: String,
        question: String,
    ): SupportProgramEvidenceAnswerResult {
        val program = detailService.get(sourceCode, sourceProgramId)
        if (program.sourceCode != BIZINFO_SOURCE_CODE) throw SupportProgramEvidenceNotSupportedException()
        val document = currentSourceDocument(program)
        return aiEvidenceFacade.answer(
            question = question.trim(),
            chunks = chunksFor(document),
            sourceUrl = document.sourceUrl,
        )
    }

    /**
     * 공고의 현재 원문을 확보해 청킹만 합니다(색인·답변 없음). 도우미 관심 공고 질문과 원문 선수집이 씁니다.
     * 기업마당 공고가 아니면 [SupportProgramEvidenceNotSupportedException], 수집 실패는 [SupportProgramEvidenceUnavailableException]입니다.
     */
    fun prepareChunks(program: SupportProgram): List<SupportProgramEvidenceChunk> {
        if (program.sourceCode != BIZINFO_SOURCE_CODE) throw SupportProgramEvidenceNotSupportedException()
        return chunksFor(currentSourceDocument(program))
    }

    private fun currentSourceDocument(program: SupportProgram): SupportProgramSourceDocument {
        val cached = try {
            repository.findPresentSourceDocument(program.sourceCode, program.id)
        } catch (_: IllegalArgumentException) {
            // 이전 버전에서 저장된 읽을 수 없는 원문은 재수집해 교체합니다.
            null
        }
        if (cached != null && cached.sourceUrl == program.sourceUrl && isFresh(cached)) return cached

        val loaded = try {
            sourceDocumentFacade.load(program)
        } catch (exception: SupportProgramSourceDocumentFacadeException) {
            throw SupportProgramEvidenceUnavailableException(exception)
        }
        // 외부 HTML을 모두 검증한 뒤에만 짧은 DB transaction으로 저장합니다.
        repository.upsertSourceDocument(loaded)
        return loaded
    }

    private fun chunksFor(document: SupportProgramSourceDocument): List<SupportProgramEvidenceChunk> {
        val started = System.nanoTime()
        var cacheState = "miss"
        var outcome = "failure"
        var chunkCount = 0
        try {
            synchronized(chunkCacheLock) {
                chunkCache[document.sourceQualifiedId]?.takeIf { it.contentHash == document.contentHash }?.let {
                    cacheState = "hit"
                    chunkCount = it.chunks.size
                    outcome = "success"
                    return it.chunks
                }
            }
            // 원문은 매 요청 최신 URL·갱신 기한·내용 해시를 검증합니다. 불변 청킹 결과만 재사용합니다.
            val prepared = PreparedChunks(document.contentHash, SupportProgramEvidenceChunker.chunk(document))
            return synchronized(chunkCacheLock) {
                val current = chunkCache[document.sourceQualifiedId]
                val selected = if (current?.contentHash == document.contentHash) current else prepared.also {
                    chunkCache[document.sourceQualifiedId] = it
                    while (chunkCache.size > MAX_CACHED_DOCUMENTS) {
                        chunkCache.remove(chunkCache.keys.first())
                    }
                }
                chunkCount = selected.chunks.size
                outcome = "success"
                selected.chunks
            }
        } catch (exception: IllegalStateException) {
            throw SupportProgramEvidenceUnavailableException(exception)
        } finally {
            logger.info(
                "support_program_evidence_chunks cache_state={} outcome={} chunk_count={} elapsed_ms={}",
                cacheState, outcome, chunkCount, (System.nanoTime() - started) / 1_000_000,
            )
        }
    }

    private data class PreparedChunks(val contentHash: String, val chunks: List<SupportProgramEvidenceChunk>)

    private fun isFresh(document: SupportProgramSourceDocument): Boolean =
        !document.fetchedAt.isBefore(LocalDateTime.now(clock).minus(REFRESH_AFTER))

    private companion object {
        val logger = LoggerFactory.getLogger(SupportProgramEvidenceService::class.java)
        const val MAX_CACHED_DOCUMENTS = 32
        const val BIZINFO_SOURCE_CODE = "BIZINFO"
        val REFRESH_AFTER: Duration = Duration.ofHours(6)
    }
}
