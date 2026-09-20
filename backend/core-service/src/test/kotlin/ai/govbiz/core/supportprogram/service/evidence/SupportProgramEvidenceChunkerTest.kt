package ai.govbiz.core.supportprogram.service.evidence

import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SupportProgramEvidenceChunkerTest {

    @Test
    fun createsDeterministicBoundedChunksWithIndependentContentHashes() {
        val content = (1..8).joinToString("\n") { index ->
            "문단 $index: 서울 AI 중소기업 지원 조건과 신청 방법을 확인합니다."
        }
        val document = sourceDocument(content)

        val first = SupportProgramEvidenceChunker.chunk(document)
        val second = SupportProgramEvidenceChunker.chunk(document)

        assertEquals(first, second)
        assertTrue(first.isNotEmpty())
        assertTrue(first.size <= 50)
        first.forEachIndexed { order, chunk ->
            assertEquals(order, chunk.order)
            assertEquals("BIZINFO:PBLN_TEST", chunk.documentId)
            assertEquals(64, chunk.id.length)
            assertEquals(SupportProgramContentHashHelper.sha256(chunk.text), chunk.contentHash)
            assertTrue(chunk.text.length <= 1_500)
        }
    }

    @Test
    fun splitsLongUnbrokenTextWithoutLosingAnyCharacter() {
        val source = "가".repeat(3_100)
        val chunks = SupportProgramEvidenceChunker.chunk(sourceDocument(source))

        assertTrue(chunks.size >= 3)
        assertEquals(source, chunks.joinToString("") { it.text })
    }

    @Test
    fun preservesSupplementaryCharactersAtTheChunkBoundary() {
        val source = "가".repeat(1_499) + "🙂" + "나".repeat(1_501)
        val chunks = SupportProgramEvidenceChunker.chunk(sourceDocument(source))

        assertEquals(source, chunks.joinToString("") { it.text })
        chunks.forEach { chunk ->
            assertTrue(chunk.text.length <= 1_500)
            assertEquals(chunk.text, String(chunk.text.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
        }
    }

    @Test
    fun packsManyShortSectionsWithTheSameSeparatorsAndChunkBoundaries() {
        val source = List(10_000) { "가" }.joinToString("\n")

        val chunks = SupportProgramEvidenceChunker.chunk(sourceDocument(source))

        val expectedChunk = List(500) { "가" }.joinToString("\n\n")
        assertEquals(List(20) { expectedChunk }, chunks.map { it.text })
    }

    @Test
    fun keepsAnExactlyFullChunkAndStartsTheNextSectionWithoutLeadingSeparators() {
        val first = "가".repeat(749)
        val second = "나".repeat(749)

        val chunks = SupportProgramEvidenceChunker.chunk(sourceDocument("$first\n$second\n끝"))

        assertEquals(listOf("$first\n\n$second", "끝"), chunks.map { it.text })
        assertEquals(1_500, chunks.first().text.length)
    }

    private fun sourceDocument(content: String): SupportProgramSourceDocument =
        SupportProgramSourceDocument(
            sourceCode = "BIZINFO",
            sourceProgramId = "PBLN_TEST",
            sourceUrl = "https://www.bizinfo.go.kr/detail?id=PBLN_TEST",
            content = content,
            contentHash = SupportProgramContentHashHelper.sha256(content),
            fetchedAt = LocalDateTime.of(2026, 9, 5, 12, 0),
        )
}
