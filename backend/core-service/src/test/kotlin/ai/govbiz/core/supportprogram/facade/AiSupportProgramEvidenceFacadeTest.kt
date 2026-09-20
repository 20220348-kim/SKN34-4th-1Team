package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramEvidenceClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceAnswerPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceAnswerRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceChunkRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceIndexPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceIndexRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceMatchPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceSearchPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceSearchRequest
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerStatus
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceChunk
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoMoreInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class AiSupportProgramEvidenceFacadeTest {

    @Mock
    private lateinit var client: AiSupportProgramEvidenceClient

    @Test
    fun indexesRetrievesAnswersAndMapsOnlyCitedOfficialChunks() {
        val citedText = "공고 안내입니다. ".repeat(60) + "\n신청 방법: 온라인 접수입니다."
        val chunks = listOf(chunk(0, "첫 번째 근거"), chunk(1, citedText))
        val indexRequest = indexRequest(chunks)
        doReturn(AiSupportProgramEvidenceIndexPayload(2)).`when`(client).indexChunks(indexRequest)
        doReturn(
            AiSupportProgramEvidenceSearchPayload(
                QUESTION,
                listOf(match(chunks[1], 0.9), match(chunks[0], 0.8)),
            ),
        ).`when`(client).searchChunks(searchRequest(indexRequest))
        doReturn(
            AiSupportProgramEvidenceAnswerPayload(
                "신청 방법은 온라인 접수입니다.",
                "ANSWERED",
                listOf(chunks[1].id),
            ),
        ).`when`(client).answer(answerRequest(QUESTION, listOf(chunks[1], chunks[0])))

        val result = AiSupportProgramEvidenceFacade(client).answer(QUESTION, chunks, SOURCE_URL)

        assertEquals(SupportProgramEvidenceAnswerStatus.ANSWERED, result.answerStatus)
        assertEquals("신청 방법은 온라인 접수입니다.", result.answer)
        assertEquals(listOf(chunks[1].order), result.citations.map { it.chunkOrder })
        assertEquals(SOURCE_URL, result.citations.single().sourceUrl)
        assertEquals(citedText, result.citations.single().excerpt)
    }

    @Test
    fun rejectsIncompleteSearchAndUngroundedAnswerCitations() {
        val chunks = chunks()
        val indexRequest = indexRequest(chunks)
        doReturn(AiSupportProgramEvidenceIndexPayload(2)).`when`(client).indexChunks(indexRequest)
        doReturn(
            AiSupportProgramEvidenceSearchPayload(QUESTION, listOf(match(chunks[0], 0.9))),
        ).`when`(client).searchChunks(searchRequest(indexRequest))

        assertInvalid(chunks)

        doReturn(
            AiSupportProgramEvidenceSearchPayload(
                QUESTION,
                listOf(match(chunks[0], 0.9), match(chunks[1], 0.8)),
            ),
        ).`when`(client).searchChunks(searchRequest(indexRequest))
        doReturn(
            AiSupportProgramEvidenceAnswerPayload("근거 없는 답변", "ANSWERED", emptyList()),
        ).`when`(client).answer(answerRequest(QUESTION, chunks))

        assertInvalid(chunks)
    }

    @Test
    fun acceptsAnswerAtTheUnicodeCodePointLimit() {
        val answer = "가".repeat(1_199) + "😀"
        assertEquals(1_200, answer.codePointCount(0, answer.length))
        assertEquals(1_201, answer.length)

        val chunks = chunks()
        val indexRequest = indexRequest(chunks)
        doReturn(AiSupportProgramEvidenceIndexPayload(2)).`when`(client).indexChunks(indexRequest)
        doReturn(
            AiSupportProgramEvidenceSearchPayload(
                QUESTION,
                listOf(match(chunks[0], 0.9), match(chunks[1], 0.8)),
            ),
        ).`when`(client).searchChunks(searchRequest(indexRequest))
        doReturn(
            AiSupportProgramEvidenceAnswerPayload(answer, "ANSWERED", listOf(chunks[0].id)),
        ).`when`(client).answer(answerRequest(QUESTION, chunks))

        val result = AiSupportProgramEvidenceFacade(client).answer(QUESTION, chunks, SOURCE_URL)

        assertEquals(answer, result.answer)
    }

    @Test
    fun rejectsAnswerAboveTheUnicodeCodePointLimit() {
        val answer = "가".repeat(1_200) + "😀"
        assertEquals(1_201, answer.codePointCount(0, answer.length))

        val chunks = chunks()
        val indexRequest = indexRequest(chunks)
        doReturn(AiSupportProgramEvidenceIndexPayload(2)).`when`(client).indexChunks(indexRequest)
        doReturn(
            AiSupportProgramEvidenceSearchPayload(
                QUESTION,
                listOf(match(chunks[0], 0.9), match(chunks[1], 0.8)),
            ),
        ).`when`(client).searchChunks(searchRequest(indexRequest))
        doReturn(
            AiSupportProgramEvidenceAnswerPayload(answer, "ANSWERED", listOf(chunks[0].id)),
        ).`when`(client).answer(answerRequest(QUESTION, chunks))

        assertInvalid(chunks)
    }

    @ParameterizedTest
    @ValueSource(strings = ["id", "contentHash", "documentId", "order", "duplicate"])
    fun rejectsRetrievedChunksThatDoNotMatchTheCurrentOfficialDocument(alteredField: String) {
        val chunks = chunks()
        val expected = match(chunks[0], 0.9)
        val altered = when (alteredField) {
            "id" -> expected.copy(id = SupportProgramContentHashHelper.sha256("unknown-chunk"))
            "contentHash" -> expected.copy(contentHash = SupportProgramContentHashHelper.sha256("stale-text"))
            "documentId" -> expected.copy(documentId = "OTHER:PBLN_TEST")
            "order" -> expected.copy(order = chunks[0].order + 1)
            "duplicate" -> match(chunks[1], 0.9)
            else -> error("unexpected test field")
        }
        val indexRequest = indexRequest(chunks)
        doReturn(AiSupportProgramEvidenceIndexPayload(chunks.size)).`when`(client).indexChunks(indexRequest)
        doReturn(
            AiSupportProgramEvidenceSearchPayload(QUESTION, listOf(altered, match(chunks[1], 0.8))),
        ).`when`(client).searchChunks(searchRequest(indexRequest))

        assertInvalid(chunks)

        verify(client).indexChunks(indexRequest)
        verify(client).searchChunks(searchRequest(indexRequest))
        verifyNoMoreInteractions(client)
    }

    @Test
    fun sendsOnlyTheFiveRetrievedChunksToTheAnswerAndPreservesTheCitedOriginalText() {
        val chunks = (0..5).map { chunk(it, "공식 문단 $it: 사업계획서와 사업자등록증을 제출합니다.") }
        val retrieved = chunks.drop(1).reversed()
        stubRetrieval(chunks, retrieved)
        doReturn(
            AiSupportProgramEvidenceAnswerPayload(
                "사업계획서와 사업자등록증을 제출합니다.",
                "ANSWERED",
                listOf(retrieved.last().id, retrieved.first().id),
            ),
        ).`when`(client).answer(answerRequest(QUESTION, retrieved))

        val result = AiSupportProgramEvidenceFacade(client).answer(QUESTION, chunks, SOURCE_URL)

        assertEquals(listOf(retrieved.last().text, retrieved.first().text), result.citations.map { it.excerpt })
        assertEquals(listOf(retrieved.last().order, retrieved.first().order), result.citations.map { it.chunkOrder })
        assertEquals(listOf(SOURCE_URL, SOURCE_URL), result.citations.map { it.sourceUrl })
        verify(client).indexChunks(indexRequest(chunks))
        verify(client).searchChunks(searchRequest(indexRequest(chunks)))
        verify(client).answer(answerRequest(QUESTION, retrieved))
        verifyNoMoreInteractions(client)
    }

    @Test
    fun rejectsACitationToAnIndexedButNotRetrievedChunk() {
        val chunks = (0..5).map { chunk(it, "공식 문단 $it") }
        val retrieved = chunks.take(5)
        stubRetrieval(chunks, retrieved)
        doReturn(
            AiSupportProgramEvidenceAnswerPayload("제출 서류 안내입니다.", "ANSWERED", listOf(chunks.last().id)),
        ).`when`(client).answer(answerRequest(QUESTION, retrieved))

        assertInvalid(chunks)
    }

    @Test
    fun returnsInsufficientEvidenceWithoutInventingCitations() {
        val chunks = chunks()
        stubRetrieval(chunks)
        val answer = "공식 원문에 제출 서류가 명시되어 있지 않아 확인할 수 없습니다."
        doReturn(
            AiSupportProgramEvidenceAnswerPayload(answer, "INSUFFICIENT_EVIDENCE", emptyList()),
        ).`when`(client).answer(answerRequest(QUESTION, chunks))

        val result = AiSupportProgramEvidenceFacade(client).answer(QUESTION, chunks, SOURCE_URL)

        assertEquals(SupportProgramEvidenceAnswerStatus.INSUFFICIENT_EVIDENCE, result.answerStatus)
        assertEquals(answer, result.answer)
        assertEquals(emptyList<Any>(), result.citations)
    }

    @Test
    fun rejectsInsufficientEvidenceThatIncludesACitation() {
        val chunks = chunks()
        stubRetrieval(chunks)
        doReturn(
            AiSupportProgramEvidenceAnswerPayload("원문에서 확인할 수 없습니다.", "INSUFFICIENT_EVIDENCE", listOf(chunks[0].id)),
        ).`when`(client).answer(answerRequest(QUESTION, chunks))

        assertInvalid(chunks)
    }

    @ParameterizedTest
    @ValueSource(strings = ["duplicate", "unknown", "null"])
    fun rejectsMalformedCitationIds(citationCase: String) {
        val chunks = chunks()
        stubRetrieval(chunks)
        val citations: List<String?> = when (citationCase) {
            "duplicate" -> listOf(chunks[0].id, chunks[0].id)
            "unknown" -> listOf(SupportProgramContentHashHelper.sha256("another-program-chunk"))
            "null" -> listOf(null)
            else -> error("unexpected citation case")
        }
        doReturn(
            AiSupportProgramEvidenceAnswerPayload("제출 서류 안내입니다.", "ANSWERED", citations),
        ).`when`(client).answer(answerRequest(QUESTION, chunks))

        assertInvalid(chunks)
    }

    @Test
    fun stopsBeforeSearchWhenIndexingDoesNotAcknowledgeEveryChunk() {
        val chunks = chunks()
        val indexRequest = indexRequest(chunks)
        doReturn(AiSupportProgramEvidenceIndexPayload(chunks.size - 1)).`when`(client).indexChunks(indexRequest)

        assertInvalid(chunks)

        verify(client).indexChunks(indexRequest)
        verifyNoMoreInteractions(client)
    }

    @Test
    fun stopsBeforeAnsweringWhenSearchEchoesADifferentQuestion() {
        val chunks = chunks()
        val indexRequest = indexRequest(chunks)
        doReturn(AiSupportProgramEvidenceIndexPayload(chunks.size)).`when`(client).indexChunks(indexRequest)
        doReturn(
            AiSupportProgramEvidenceSearchPayload("다른 공고에 대한 질문", chunks.mapIndexed { index, chunk ->
                match(chunk, 0.9 - index * 0.1)
            }),
        ).`when`(client).searchChunks(searchRequest(indexRequest))

        assertInvalid(chunks)

        verify(client).indexChunks(indexRequest)
        verify(client).searchChunks(searchRequest(indexRequest))
        verifyNoMoreInteractions(client)
    }

    private fun stubRetrieval(
        chunks: List<SupportProgramEvidenceChunk>,
        retrieved: List<SupportProgramEvidenceChunk> = chunks,
    ) {
        val indexRequest = indexRequest(chunks)
        doReturn(AiSupportProgramEvidenceIndexPayload(chunks.size)).`when`(client).indexChunks(indexRequest)
        doReturn(
            AiSupportProgramEvidenceSearchPayload(QUESTION, retrieved.mapIndexed { index, chunk ->
                match(chunk, 0.9 - index * 0.1)
            }),
        ).`when`(client).searchChunks(searchRequest(indexRequest))
    }

    private fun assertInvalid(chunks: List<SupportProgramEvidenceChunk>) {
        val exception = assertThrows(AiServiceCallException::class.java) {
            AiSupportProgramEvidenceFacade(client).answer(QUESTION, chunks, SOURCE_URL)
        }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, exception.failure)
    }

    private fun match(chunk: SupportProgramEvidenceChunk, score: Double) =
        AiSupportProgramEvidenceMatchPayload(
            id = chunk.id,
            contentHash = chunk.contentHash,
            documentId = chunk.documentId,
            order = chunk.order,
            score = score,
        )

    private fun indexRequest(chunks: List<SupportProgramEvidenceChunk>) =
        AiSupportProgramEvidenceIndexRequest(chunks.map(::chunkRequest))

    private fun searchRequest(indexRequest: AiSupportProgramEvidenceIndexRequest) =
        AiSupportProgramEvidenceSearchRequest(
            question = QUESTION,
            eligibleChunks = indexRequest.chunks.map(AiSupportProgramEvidenceChunkRequest::reference),
            limit = minOf(5, indexRequest.chunks.size),
        )

    private fun answerRequest(
        question: String,
        chunks: List<SupportProgramEvidenceChunk>,
    ) = AiSupportProgramEvidenceAnswerRequest(question, chunks.map(::chunkRequest).map { it.answerInput() })

    private fun chunkRequest(chunk: SupportProgramEvidenceChunk) =
        AiSupportProgramEvidenceChunkRequest(
            id = chunk.id,
            contentHash = chunk.contentHash,
            documentId = chunk.documentId,
            order = chunk.order,
            text = chunk.text,
        )

    private fun chunks() = listOf(chunk(0, "첫 번째 근거"), chunk(1, "두 번째 근거"))

    private fun chunk(order: Int, text: String): SupportProgramEvidenceChunk {
        val contentHash = SupportProgramContentHashHelper.sha256(text)
        return SupportProgramEvidenceChunk(
            id = SupportProgramContentHashHelper.sha256("chunk-$order"),
            contentHash = contentHash,
            documentId = "BIZINFO:PBLN_TEST",
            order = order,
            text = text,
        )
    }

    private companion object {
        const val QUESTION = "신청 방법이 무엇인가요?"
        const val SOURCE_URL = "https://www.bizinfo.go.kr/detail?id=PBLN_TEST"
    }
}
