package ai.govbiz.core.supportprogram.service.evidence

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.facade.BizInfoSupportProgramSourceDocumentFacade
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramSourceDocumentFacadeException
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerStatus
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceNotSupportedException
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceUnavailableException
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.ArgumentMatchers.anyList
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.mockingDetails
import org.mockito.Mockito.times
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.inOrder
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.Mockito.verifyNoMoreInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class SupportProgramEvidenceServiceTest {

    @Mock
    private lateinit var detailService: SupportProgramDetailService

    @Mock
    private lateinit var repository: SupportProgramRepository

    @Mock
    private lateinit var sourceDocumentFacade: BizInfoSupportProgramSourceDocumentFacade

    @Mock
    private lateinit var aiEvidenceFacade: AiSupportProgramEvidenceFacade

    private lateinit var service: SupportProgramEvidenceService

    @BeforeEach
    fun setUp() {
        service = SupportProgramEvidenceService(
            detailService,
            repository,
            sourceDocumentFacade,
            aiEvidenceFacade,
            Clock.fixed(Instant.parse("2026-09-05T03:00:00Z"), ZoneId.of("Asia/Seoul")),
        )
    }

    @Test
    fun reusesAFreshCurrentDocumentWithoutFetchingTheSourceAgain() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val cached = document(program, LocalDateTime.of(2026, 9, 5, 11, 0))
        doReturn(program).`when`(detailService).get("BIZINFO", "PBLN_TEST")
        doReturn(cached).`when`(repository).findPresentSourceDocument("BIZINFO", "PBLN_TEST")
        doReturn(answer()).`when`(aiEvidenceFacade).answer(
            QUESTION,
            SupportProgramEvidenceChunker.chunk(cached),
            program.sourceUrl,
        )

        val result = service.answer("BIZINFO", "PBLN_TEST", "  $QUESTION  ")

        assertEquals(answer(), result)
        verify(sourceDocumentFacade, never()).load(program)
        verify(repository, never()).upsertSourceDocument(cached)
    }

    @Test
    fun refreshesStaleDocumentOutsideTheRepositoryTransactionThenStoresIt() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val stale = document(program, LocalDateTime.of(2026, 9, 5, 4, 59))
        val refreshed = document(program, LocalDateTime.of(2026, 9, 5, 11, 0), content = "갱신한 공식 원문입니다. 신청은 온라인으로 합니다.")
        doReturn(program).`when`(detailService).get("BIZINFO", "PBLN_TEST")
        doReturn(stale).`when`(repository).findPresentSourceDocument("BIZINFO", "PBLN_TEST")
        doReturn(refreshed).`when`(sourceDocumentFacade).load(program)
        doReturn(answer()).`when`(aiEvidenceFacade).answer(
            QUESTION,
            SupportProgramEvidenceChunker.chunk(refreshed),
            program.sourceUrl,
        )

        service.answer("BIZINFO", "PBLN_TEST", QUESTION)

        verify(sourceDocumentFacade).load(program)
        verify(repository).upsertSourceDocument(refreshed)
    }

    @Test
    fun refusesUnsupportedSourceBeforeFetchingOrCallingAi() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program.copy(
            sourceCode = "OTHER",
            sourceName = "다른 제공처",
            sourceUrl = "https://support-programs.other.test/PBLN_TEST",
        )
        doReturn(program).`when`(detailService).get("OTHER", "PBLN_TEST")

        assertThrows(SupportProgramEvidenceNotSupportedException::class.java) {
            service.answer("OTHER", "PBLN_TEST", QUESTION)
        }
        verifyNoInteractions(repository, sourceDocumentFacade, aiEvidenceFacade)
    }

    @Test
    fun hidesBizInfoDetailClientFailureAsEvidenceUnavailable() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        doReturn(program).`when`(detailService).get("BIZINFO", "PBLN_TEST")
        doReturn(null).`when`(repository).findPresentSourceDocument("BIZINFO", "PBLN_TEST")
        doThrow(sourceFailure()).`when`(sourceDocumentFacade).load(program)

        assertThrows(SupportProgramEvidenceUnavailableException::class.java) {
            service.answer("BIZINFO", "PBLN_TEST", QUESTION)
        }
    }

    @Test
    fun turnsAnOversizedLegacyDocumentIntoAnEvidenceUnavailableResult() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val oversizedDocument = document(
            program = program,
            fetchedAt = LocalDateTime.of(2026, 9, 5, 11, 0),
            content = (1..51).joinToString("\n") { "가".repeat(1_500) },
        )
        doReturn(program).`when`(detailService).get("BIZINFO", "PBLN_TEST")
        doReturn(oversizedDocument).`when`(repository)
            .findPresentSourceDocument("BIZINFO", "PBLN_TEST")

        assertThrows(SupportProgramEvidenceUnavailableException::class.java) {
            service.answer("BIZINFO", "PBLN_TEST", QUESTION)
        }

        verifyNoInteractions(sourceDocumentFacade, aiEvidenceFacade)
    }

    @Test
    fun refreshesAFreshDocumentWhenTheOfficialUrlHasChanged() {
        val original = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val program = original.copy(
            sourceUrl = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST",
        )
        val cached = document(original, LocalDateTime.of(2026, 9, 5, 11, 0))
        val refreshed = document(program, LocalDateTime.of(2026, 9, 5, 12, 0), "변경한 공식 URL에서 수집한 신청 방법입니다.")
        doReturn(program).`when`(detailService).get("BIZINFO", "PBLN_TEST")
        doReturn(cached).`when`(repository).findPresentSourceDocument("BIZINFO", "PBLN_TEST")
        doReturn(refreshed).`when`(sourceDocumentFacade).load(program)
        doReturn(answer()).`when`(aiEvidenceFacade).answer(
            QUESTION,
            SupportProgramEvidenceChunker.chunk(refreshed),
            program.sourceUrl,
        )

        assertEquals(answer(), service.answer("BIZINFO", "PBLN_TEST", QUESTION))

        val ordered = inOrder(sourceDocumentFacade, repository, aiEvidenceFacade)
        ordered.verify(sourceDocumentFacade).load(program)
        ordered.verify(repository).upsertSourceDocument(refreshed)
        ordered.verify(aiEvidenceFacade).answer(QUESTION, SupportProgramEvidenceChunker.chunk(refreshed), program.sourceUrl)
    }

    @Test
    fun refetchesADocumentWhoseStoredContentCannotPassHashValidation() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val refreshed = document(program, LocalDateTime.of(2026, 9, 5, 12, 0))
        doReturn(program).`when`(detailService).get("BIZINFO", "PBLN_TEST")
        doThrow(IllegalArgumentException("contentHash must match the UTF-8 source document content"))
            .`when`(repository).findPresentSourceDocument("BIZINFO", "PBLN_TEST")
        doReturn(refreshed).`when`(sourceDocumentFacade).load(program)
        doReturn(answer()).`when`(aiEvidenceFacade).answer(
            QUESTION,
            SupportProgramEvidenceChunker.chunk(refreshed),
            program.sourceUrl,
        )

        assertEquals(answer(), service.answer("BIZINFO", "PBLN_TEST", QUESTION))

        verify(sourceDocumentFacade).load(program)
        verify(repository).upsertSourceDocument(refreshed)
    }

    @Test
    fun doesNotAnswerFromAnExpiredDocumentWhenItsRefreshFails() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val stale = document(program, LocalDateTime.of(2026, 9, 5, 4, 59))
        val failure = sourceFailure()
        doReturn(program).`when`(detailService).get("BIZINFO", "PBLN_TEST")
        doReturn(stale).`when`(repository).findPresentSourceDocument("BIZINFO", "PBLN_TEST")
        doThrow(failure).`when`(sourceDocumentFacade).load(program)

        val exception = assertThrows(SupportProgramEvidenceUnavailableException::class.java) {
            service.answer("BIZINFO", "PBLN_TEST", QUESTION)
        }

        assertSame(failure, exception.cause)
        verify(repository).findPresentSourceDocument("BIZINFO", "PBLN_TEST")
        verifyNoMoreInteractions(repository)
        verifyNoInteractions(aiEvidenceFacade)
    }

    @Test
    fun stopsBeforeCallingAiWhenTheRefreshedDocumentCannotBeStored() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val refreshed = document(program, LocalDateTime.of(2026, 9, 5, 12, 0))
        val failure = IllegalStateException("database write failed")
        doReturn(program).`when`(detailService).get("BIZINFO", "PBLN_TEST")
        doReturn(null).`when`(repository).findPresentSourceDocument("BIZINFO", "PBLN_TEST")
        doReturn(refreshed).`when`(sourceDocumentFacade).load(program)
        doThrow(failure).`when`(repository).upsertSourceDocument(refreshed)

        val exception = assertThrows(IllegalStateException::class.java) {
            service.answer("BIZINFO", "PBLN_TEST", QUESTION)
        }

        assertSame(failure, exception)
        verifyNoInteractions(aiEvidenceFacade)
    }

    @Test
    fun stopsBeforeReadingSourceDocumentsWhenTheSelectedProgramIsNotPresent() {
        val failure = SupportProgramNotFoundException()
        doThrow(failure).`when`(detailService).get("BIZINFO", "PBLN_TEST")

        val exception = assertThrows(SupportProgramNotFoundException::class.java) {
            service.answer("BIZINFO", "PBLN_TEST", QUESTION)
        }

        assertSame(failure, exception)
        verifyNoInteractions(repository, sourceDocumentFacade, aiEvidenceFacade)
    }

    @Test
    fun reusesImmutableChunksAcrossQuestionsAndRefreshTimesButStillChecksTheCurrentDocument() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val first = document(program, LocalDateTime.of(2026, 9, 5, 11, 0))
        val refreshed = first.copy(fetchedAt = LocalDateTime.of(2026, 9, 5, 12, 0))
        doReturn(program).`when`(detailService).get("BIZINFO", program.id)
        doReturn(first, refreshed).`when`(repository).findPresentSourceDocument("BIZINFO", program.id)
        doReturn(answer()).`when`(aiEvidenceFacade).answer(anyString(), anyList(), anyString())

        service.answer("BIZINFO", program.id, QUESTION)
        service.answer("BIZINFO", program.id, "문의처는 어디인가요?")

        val chunks = requestedChunks()
        assertSame(chunks[0], chunks[1])
        assertEquals(SupportProgramEvidenceChunker.chunk(first), chunks[0])
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (chunks[0] as MutableList<SupportProgramEvidenceChunk>).clear()
        }
        verify(repository, times(2)).findPresentSourceDocument("BIZINFO", program.id)
        verifyNoInteractions(sourceDocumentFacade)
    }

    @Test
    fun replacesPreparedChunksImmediatelyWhenTheCurrentContentChanges() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val first = document(program, LocalDateTime.of(2026, 9, 5, 11, 0))
        val changed = document(program, first.fetchedAt, "신청 방법이 방문 접수로 변경되었습니다.")
        doReturn(program).`when`(detailService).get("BIZINFO", program.id)
        doReturn(first, changed).`when`(repository).findPresentSourceDocument("BIZINFO", program.id)
        doReturn(answer()).`when`(aiEvidenceFacade).answer(anyString(), anyList(), anyString())

        repeat(2) { service.answer("BIZINFO", program.id, QUESTION) }

        val chunks = requestedChunks()
        assertNotSame(chunks[0], chunks[1])
        assertEquals(SupportProgramEvidenceChunker.chunk(changed), chunks[1])
        assertNotEquals(chunks[0][0].id, chunks[1][0].id)
    }

    @Test
    fun boundsTheChunkCacheAndKeepsIdenticalTextFromDifferentProgramsSeparate() {
        val programs = (0..32).map { SupportProgramTestHelper.catalogProgram("PBLN_CACHE_$it").program }
        val fetchedAt = LocalDateTime.of(2026, 9, 5, 11, 0)
        doReturn(answer()).`when`(aiEvidenceFacade).answer(anyString(), anyList(), anyString())
        for (program in programs) {
            doReturn(program).`when`(detailService).get("BIZINFO", program.id)
            doReturn(document(program, fetchedAt)).`when`(repository).findPresentSourceDocument("BIZINFO", program.id)
            service.answer("BIZINFO", program.id, QUESTION)
        }
        service.answer("BIZINFO", programs.first().id, QUESTION)

        val chunks = requestedChunks()
        assertNotEquals(chunks[0][0].documentId, chunks[1][0].documentId)
        assertNotEquals(chunks[0][0].id, chunks[1][0].id)
        assertEquals(chunks.first(), chunks.last())
        assertNotSame(chunks.first(), chunks.last())
    }

    @Test
    fun doesNotUsePreparedChunksWhenRefreshingTheSourceFails() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program
        val fresh = document(program, LocalDateTime.of(2026, 9, 5, 11, 0))
        val stale = fresh.copy(fetchedAt = LocalDateTime.of(2026, 9, 5, 4, 59))
        doReturn(program).`when`(detailService).get("BIZINFO", program.id)
        doReturn(fresh, stale).`when`(repository).findPresentSourceDocument("BIZINFO", program.id)
        doReturn(answer()).`when`(aiEvidenceFacade).answer(anyString(), anyList(), anyString())
        doThrow(sourceFailure()).`when`(sourceDocumentFacade).load(program)

        service.answer("BIZINFO", program.id, QUESTION)
        assertThrows(SupportProgramEvidenceUnavailableException::class.java) {
            service.answer("BIZINFO", program.id, QUESTION)
        }

        assertEquals(1, requestedChunks().size)
    }

    @Suppress("UNCHECKED_CAST")
    private fun requestedChunks(): List<List<SupportProgramEvidenceChunk>> =
        mockingDetails(aiEvidenceFacade).invocations.filter { it.method.name == "answer" }
            .map { it.arguments[1] as List<SupportProgramEvidenceChunk> }

    private fun answer() = SupportProgramEvidenceAnswerResult(
        answer = "공식 원문에서 온라인 신청을 확인했습니다.",
        answerStatus = SupportProgramEvidenceAnswerStatus.ANSWERED,
        citations = emptyList(),
    )

    private fun document(
        program: SupportProgram,
        fetchedAt: LocalDateTime,
        content: String = "공식 공고 원문입니다. 온라인 신청 방법과 문의처를 안내합니다.",
    ) = SupportProgramSourceDocument(
        sourceCode = program.sourceCode,
        sourceProgramId = program.id,
        sourceUrl = program.sourceUrl,
        content = content,
        contentHash = SupportProgramContentHashHelper.sha256(content),
        fetchedAt = fetchedAt,
    )

    private fun sourceFailure(): SupportProgramSourceDocumentFacadeException =
        SupportProgramSourceDocumentFacadeException.fromClient(
            SupportProgramSourceDocumentFacadeException.Failure.UNAVAILABLE,
            "private upstream detail",
            IllegalStateException("private upstream detail"),
        )

    private companion object {
        const val QUESTION = "신청 방법이 무엇인가요?"
    }
}
