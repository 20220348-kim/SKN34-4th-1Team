package ai.govbiz.core.supportprogram.service.evidence

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.facade.SupportProgramSourceDocumentFacade
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramSourceDocumentFacadeException
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.helper.SupportProgramEvidenceTracingHelper
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

/** 특정 기업마당·K-Startup 공고의 공식 상세 원문을 근거로 질문에 답합니다. */
@Service
class SupportProgramEvidenceService(
    private val detailService: SupportProgramDetailService,
    private val repository: SupportProgramRepository,
    private val sourceDocumentFacade: SupportProgramSourceDocumentFacade,
    private val aiEvidenceFacade: AiSupportProgramEvidenceFacade,
    @param:Qualifier("seoulClock") private val clock: Clock,
    private val tracing: SupportProgramEvidenceTracingHelper = SupportProgramEvidenceTracingHelper(),
) {
    private val chunkCacheLock = Any()
    private val chunkCache = LinkedHashMap<String, PreparedChunks>(16, 0.75f, true)

    fun answer(
        sourceCode: String,
        sourceProgramId: String,
        question: String,
    ): SupportProgramEvidenceAnswerResult = tracing.observe("total") {
        val program = tracing.observe("core.detail") { detailService.get(sourceCode, sourceProgramId) }
        val sourceLabel = EVIDENCE_SOURCE_LABELS[program.sourceCode] ?: throw SupportProgramEvidenceNotSupportedException()
        val document = tracing.observe("core.source") { currentSourceDocument(program) }
        val chunks = tracing.observe("core.chunk") { chunksFor(document) }
        aiEvidenceFacade.answer(
            question = question.trim(),
            chunks = chunks,
            sourceUrl = document.sourceUrl,
            sourceLabel = sourceLabel,
        )
    }

    /**
     * 공고의 현재 원문을 확보해 청킹만 합니다(색인·답변 없음). 도우미 관심 공고 질문과 원문 선수집이 씁니다.
     * [EVIDENCE_SOURCE_LABELS]에 없는 제공처 공고면 [SupportProgramEvidenceNotSupportedException], 수집 실패는 [SupportProgramEvidenceUnavailableException]입니다.
     */
    fun prepareChunks(program: SupportProgram): List<SupportProgramEvidenceChunk> {
        if (program.sourceCode !in EVIDENCE_SOURCE_LABELS) throw SupportProgramEvidenceNotSupportedException()
        return chunksFor(currentSourceDocument(program))
    }

    private fun currentSourceDocument(program: SupportProgram): SupportProgramSourceDocument {
        val cached = try {
            repository.findPresentSourceDocument(program.sourceCode, program.id)
        } catch (_: IllegalArgumentException) {
            // 이전 버전에서 저장된 읽을 수 없는 원문은 재수집해 교체합니다.
            null
        }
        if (cached != null && cached.sourceUrl == program.sourceUrl && isFresh(cached)) {
            tracing.recordCache("hit")
            return cached
        }
        tracing.recordCache("miss")

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
            tracing.recordCache(cacheState, chunkCount)
            logger.info(
                "support_program_evidence_chunks cache_state={} outcome={} chunk_count={} elapsed_ms={}",
                cacheState, outcome, chunkCount, (System.nanoTime() - started) / 1_000_000,
            )
        }
    }

    private data class PreparedChunks(val contentHash: String, val chunks: List<SupportProgramEvidenceChunk>)

    private fun isFresh(document: SupportProgramSourceDocument): Boolean =
        !document.fetchedAt.isBefore(LocalDateTime.now(clock).minus(REFRESH_AFTER))

    companion object {
        private val logger = LoggerFactory.getLogger(SupportProgramEvidenceService::class.java)
        private const val MAX_CACHED_DOCUMENTS = 32
        /**
         * 공식 상세 원문 근거 답변을 지원하는 제공처와 근거 링크에 보일 원문 이름입니다. 답변·선수집의 지원 여부,
         * 상세 응답의 `evidenceQuestionSupported`, 인용의 `sourceLabel`을 모두 이 값 하나로 정합니다.
         * 과기정통부(MSIT)는 상세 본문이 첨부 안내뿐이고 충남 수출지원(CNTRADE_NOTICE)은 상세 주소를 만들 수 없어 제외합니다.
         */
        val EVIDENCE_SOURCE_LABELS: Map<String, String> = mapOf(
            "BIZINFO" to "기업마당 상세 본문",
            "KSTARTUP" to "K-Startup 상세 본문",
        )
        private val REFRESH_AFTER: Duration = Duration.ofHours(6)
    }
}
