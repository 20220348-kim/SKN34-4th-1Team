package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramEvidenceClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceAnswerRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceChunkRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceIndexRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceSearchRequest
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerStatus
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceCitationResult
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceChunk
import kotlin.math.min
import org.springframework.stereotype.Component

/** 원문 청크 색인·검색·근거 답변의 AI 호출과 응답 검증을 하나로 감춥니다. */
@Component
class AiSupportProgramEvidenceFacade(
    private val client: AiSupportProgramEvidenceClient,
) {
    fun answer(
        question: String,
        chunks: List<SupportProgramEvidenceChunk>,
        sourceUrl: String,
    ): SupportProgramEvidenceAnswerResult {
        require(question.isNotBlank()) { "evidence question must not be blank" }
        require(chunks.isNotEmpty() && chunks.size <= MAX_CHUNKS) { "invalid evidence chunk count" }
        require(chunks.map(SupportProgramEvidenceChunk::id).toSet().size == chunks.size) {
            "duplicate evidence chunk ids"
        }

        val chunkRequests = chunks.map(::toChunkRequest)
        val indexed = client.indexChunks(AiSupportProgramEvidenceIndexRequest(chunkRequests))
        if (indexed.indexedCount != chunks.size) {
            throw AiServiceCallException.invalidResponse("AI evidence did not acknowledge every chunk", null)
        }

        val searched = client.searchChunks(
            AiSupportProgramEvidenceSearchRequest(
                question = question,
                eligibleChunks = chunkRequests.map(AiSupportProgramEvidenceChunkRequest::reference),
                limit = min(MAX_RETRIEVED_CHUNKS, chunks.size),
            ),
        )
        if (searched.question != question) {
            throw AiServiceCallException.invalidResponse("AI evidence returned a different question", null)
        }

        val candidatesById = chunks.associateBy(SupportProgramEvidenceChunk::id)
        val retrieved = requireRetrievedChunks(searched.matches, candidatesById)
        val answered = client.answer(
            AiSupportProgramEvidenceAnswerRequest(
                question = question,
                chunks = retrieved.map { chunk -> toChunkRequest(chunk).answerInput() },
            ),
        )
        return validateAnswer(answered.answer, answered.answerStatus, answered.citationChunkIds, retrieved, sourceUrl)
    }

    /** 청크를 색인만 합니다. 도우미 관심 공고 질문과 원문 선수집이 검색 전에 부릅니다. */
    fun index(chunks: List<SupportProgramEvidenceChunk>) {
        require(chunks.isNotEmpty() && chunks.size <= MAX_CHUNKS) { "invalid evidence chunk count" }
        require(chunks.map(SupportProgramEvidenceChunk::id).toSet().size == chunks.size) { "duplicate evidence chunk ids" }
        val indexed = client.indexChunks(AiSupportProgramEvidenceIndexRequest(chunks.map(::toChunkRequest)))
        if (indexed.indexedCount != chunks.size) {
            throw AiServiceCallException.invalidResponse("AI evidence did not acknowledge every chunk", null)
        }
    }

    private fun requireRetrievedChunks(
        matches: List<ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceMatchPayload?>?,
        candidatesById: Map<String, SupportProgramEvidenceChunk>,
    ): List<SupportProgramEvidenceChunk> {
        val requiredCount = min(MAX_RETRIEVED_CHUNKS, candidatesById.size)
        if (matches == null || matches.size != requiredCount) {
            throw AiServiceCallException.invalidResponse("AI evidence returned an incomplete chunk search", null)
        }

        val result = ArrayList<SupportProgramEvidenceChunk>(matches.size)
        val seen = HashSet<String>()
        var previousScore = Double.POSITIVE_INFINITY
        var previousId = ""
        for (match in matches) {
            val requiredMatch = match
                ?: throw AiServiceCallException.invalidResponse("AI evidence returned a null chunk match", null)
            val id = requiredMatch.id
                ?: throw AiServiceCallException.invalidResponse("AI evidence chunk match omitted id", null)
            val score = requiredMatch.score
                ?: throw AiServiceCallException.invalidResponse("AI evidence chunk match omitted score", null)
            val expected = candidatesById[id]
                ?: throw AiServiceCallException.invalidResponse("AI evidence returned an unknown chunk", null)
            if (
                !score.isFinite() ||
                !seen.add(id) ||
                requiredMatch.contentHash != expected.contentHash ||
                requiredMatch.documentId != expected.documentId ||
                requiredMatch.order != expected.order ||
                score > previousScore ||
                (score == previousScore && id < previousId)
            ) {
                throw AiServiceCallException.invalidResponse("AI evidence returned an invalid chunk search", null)
            }
            previousScore = score
            previousId = id
            result += expected
        }
        return java.util.List.copyOf(result)
    }

    private fun validateAnswer(
        rawAnswer: String?,
        rawStatus: String?,
        rawCitationIds: List<String?>?,
        retrieved: List<SupportProgramEvidenceChunk>,
        sourceUrl: String,
    ): SupportProgramEvidenceAnswerResult {
        val answer = rawAnswer?.trim()
        if (answer.isNullOrEmpty() || answer.codePointCount(0, answer.length) > MAX_ANSWER_CODE_POINTS) {
            throw AiServiceCallException.invalidResponse("AI evidence returned an invalid answer", null)
        }
        val status = try {
            SupportProgramEvidenceAnswerStatus.valueOf(rawStatus.orEmpty())
        } catch (_: IllegalArgumentException) {
            throw AiServiceCallException.invalidResponse("AI evidence returned an invalid answer status", null)
        }
        val citationIds = rawCitationIds
            ?: throw AiServiceCallException.invalidResponse("AI evidence omitted citations", null)
        if (citationIds.any { it == null }) {
            throw AiServiceCallException.invalidResponse("AI evidence returned a null citation", null)
        }
        @Suppress("UNCHECKED_CAST")
        val nonNullCitationIds = citationIds as List<String>
        val chunksById = retrieved.associateBy(SupportProgramEvidenceChunk::id)
        if (
            nonNullCitationIds.size != nonNullCitationIds.toSet().size ||
            nonNullCitationIds.any { it !in chunksById }
        ) {
            throw AiServiceCallException.invalidResponse("AI evidence returned invalid citations", null)
        }
        if (
            (status == SupportProgramEvidenceAnswerStatus.ANSWERED && nonNullCitationIds.isEmpty()) ||
            (status == SupportProgramEvidenceAnswerStatus.INSUFFICIENT_EVIDENCE && nonNullCitationIds.isNotEmpty())
        ) {
            throw AiServiceCallException.invalidResponse("AI evidence answer and citations did not agree", null)
        }

        return SupportProgramEvidenceAnswerResult(
            answer = answer,
            answerStatus = status,
            citations = java.util.List.copyOf(
                nonNullCitationIds.map { citationId ->
                    val chunk = checkNotNull(chunksById[citationId])
                    SupportProgramEvidenceCitationResult(
                        excerpt = chunk.text,
                        sourceUrl = sourceUrl,
                        chunkOrder = chunk.order,
                    )
                },
            ),
        )
    }

    private fun toChunkRequest(chunk: SupportProgramEvidenceChunk): AiSupportProgramEvidenceChunkRequest =
        AiSupportProgramEvidenceChunkRequest(
            id = chunk.id,
            contentHash = chunk.contentHash,
            documentId = chunk.documentId,
            order = chunk.order,
            text = chunk.text,
        )

    private companion object {
        const val MAX_CHUNKS = 50
        const val MAX_RETRIEVED_CHUNKS = 5
        const val MAX_ANSWER_CODE_POINTS = 1_200
    }
}
