package ai.govbiz.core.assistant.service

import ai.govbiz.core.assistant.config.AssistantAgentProperties
import ai.govbiz.core.supportprogram.domain.SavedSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceChunk
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceNotSupportedException
import ai.govbiz.core.supportprogram.service.saved.SavedSupportProgramService
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.anyList
import org.mockito.Mockito
import org.mockito.Mockito.`when`

class AssistantSavedProgramDocumentServiceTest {
    private val savedPrograms = Mockito.mock(SavedSupportProgramService::class.java)
    private val evidence = Mockito.mock(SupportProgramEvidenceService::class.java)
    private val facade = Mockito.mock(AiSupportProgramEvidenceFacade::class.java)
    private val executor = Executors.newFixedThreadPool(4)
    private val properties = AssistantAgentProperties(toolsSecret = "assistant-tools-secret-for-tests-0123456789", documentPrepareTimeout = Duration.ofSeconds(1))
    private val service = AssistantSavedProgramDocumentService(savedPrograms, evidence, facade, properties, executor)

    @AfterEach
    fun shutdown() { executor.shutdownNow() }

    private fun program(id: String, endDate: LocalDate? = LocalDate.of(2026, 9, 30), sourceCode: String = "BIZINFO") = SupportProgram(
        id, sourceCode, "공고 $id", "기관", "요약", emptyList(), emptyList(), "대상", "기간", null, endDate, SupportProgramStatus.OPEN, "기업마당",
        "https://www.bizinfo.go.kr/$id", emptyList(),
    )

    private fun saved(program: SupportProgram) = SavedSupportProgram(LocalDateTime.of(2026, 9, 10, 10, 0), program)

    private fun chunk(program: SupportProgram, order: Int, text: String) =
        SupportProgramEvidenceChunk("c".repeat(63) + order, "h".repeat(63) + order, program.sourceQualifiedId, order, text)

    @Test
    fun preparesChunksIndexesThemAndKeepsTextsForQuoteVerification() {
        val one = program("PBLN_000000000000001")
        val two = program("PBLN_000000000000002", endDate = null)
        `when`(savedPrograms.list(7L)).thenReturn(listOf(saved(one), saved(two)))
        `when`(evidence.prepareChunks(one)).thenReturn(listOf(chunk(one, 0, "신청방법: 온라인 신청"), chunk(one, 1, "제출서류: 사업계획서")))
        `when`(evidence.prepareChunks(two)).thenReturn(listOf(chunk(two, 0, "방문 접수만 가능")))

        val prepared = service.prepare(7L)

        assertEquals(listOf("BIZINFO:PBLN_000000000000001", "BIZINFO:PBLN_000000000000002"), prepared.documents.map { it.documentId })
        val first = prepared.documents.first()
        assertEquals("BIZINFO", first.sourceCode)
        assertEquals("PBLN_000000000000001", first.sourceProgramId)
        assertEquals("2026-09-30", first.applicationEndDate)
        assertNull(prepared.documents.last().applicationEndDate)
        assertEquals(2, first.chunks.size)
        assertEquals("c".repeat(63) + "0", first.chunks.first().id)
        assertEquals(listOf("신청방법: 온라인 신청", "제출서류: 사업계획서"), prepared.chunkTexts["BIZINFO:PBLN_000000000000001"])
        Mockito.verify(facade, Mockito.times(2)).index(anyList())
    }

    @Test
    fun failedOrUnsupportedProgramsAreSentWithoutChunks() {
        val supported = program("PBLN_000000000000001")
        val unsupported = program("K-1", sourceCode = "KSTARTUP")
        val broken = program("PBLN_000000000000003")
        `when`(savedPrograms.list(7L)).thenReturn(listOf(saved(supported), saved(unsupported), saved(broken)))
        `when`(evidence.prepareChunks(supported)).thenReturn(listOf(chunk(supported, 0, "본문")))
        `when`(evidence.prepareChunks(unsupported)).thenThrow(SupportProgramEvidenceNotSupportedException())
        `when`(evidence.prepareChunks(broken)).thenThrow(IllegalStateException("fetch failed"))

        val prepared = service.prepare(7L)

        assertEquals(listOf(1, 0, 0), prepared.documents.map { it.chunks.size })
        assertEquals(setOf("BIZINFO:PBLN_000000000000001"), prepared.chunkTexts.keys)
    }

    @Test
    fun indexingFailureDropsTheChunksOfThatProgramOnly() {
        val one = program("PBLN_000000000000001")
        `when`(savedPrograms.list(7L)).thenReturn(listOf(saved(one)))
        `when`(evidence.prepareChunks(one)).thenReturn(listOf(chunk(one, 0, "본문")))
        Mockito.doThrow(IllegalStateException("index down")).`when`(facade).index(anyList())

        val prepared = service.prepare(7L)
        assertTrue(prepared.documents.single().chunks.isEmpty())
        assertTrue(prepared.chunkTexts.isEmpty())
    }

    @Test
    fun programsThatMissTheBudgetAreSentWithoutChunksWhileTheRestSucceed() {
        val fast = program("PBLN_000000000000001")
        val slow = program("PBLN_000000000000002")
        val release = CountDownLatch(1)
        `when`(savedPrograms.list(7L)).thenReturn(listOf(saved(fast), saved(slow)))
        `when`(evidence.prepareChunks(fast)).thenReturn(listOf(chunk(fast, 0, "빠른 공고")))
        `when`(evidence.prepareChunks(slow)).thenAnswer {
            release.await(10, TimeUnit.SECONDS)
            listOf(chunk(slow, 0, "느린 공고"))
        }

        val started = System.nanoTime()
        val prepared = service.prepare(7L)
        release.countDown()

        assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000, "예산(1초) 근처에서 끝납니다")
        assertEquals(listOf(1, 0), prepared.documents.map { it.chunks.size })
        assertEquals(setOf("BIZINFO:PBLN_000000000000001"), prepared.chunkTexts.keys)
    }

    @Test
    fun capsAtTenSavedProgramsAndReturnsNothingForAnEmptyBox() {
        `when`(savedPrograms.list(7L)).thenReturn((1..12).map { saved(program("PBLN_%015d".format(it))) })
        `when`(evidence.prepareChunks(any(SupportProgram::class.java) ?: program("PBLN_000000000000000"))).thenAnswer { invocation ->
            val program = invocation.getArgument<SupportProgram>(0)
            listOf(chunk(program, 0, "본문 ${program.id}"))
        }
        assertEquals(10, service.prepare(7L).documents.size)

        `when`(savedPrograms.list(8L)).thenReturn(emptyList())
        assertTrue(service.prepare(8L).documents.isEmpty())
        Mockito.verify(evidence, Mockito.times(10)).prepareChunks(any(SupportProgram::class.java) ?: program("PBLN_000000000000000"))
    }
}
