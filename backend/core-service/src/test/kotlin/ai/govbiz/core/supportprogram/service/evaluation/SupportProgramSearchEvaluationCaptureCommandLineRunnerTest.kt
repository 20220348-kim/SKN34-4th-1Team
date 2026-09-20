package ai.govbiz.core.supportprogram.service.evaluation

import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchTrace
import ai.govbiz.core.supportprogram.service.evaluation.config.SupportProgramSearchEvaluationCaptureProperties
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import tools.jackson.databind.json.JsonMapper

@ExtendWith(MockitoExtension::class)
class SupportProgramSearchEvaluationCaptureCommandLineRunnerTest {

    @TempDir
    private lateinit var directory: Path

    @Mock
    private lateinit var searchService: SupportProgramSearchService

    private val objectMapper = JsonMapper.builder().build()

    @Test
    fun writesACompleteV2CaptureOnlyAfterEveryQuerySucceeds() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "real-catalog-v1",
              "queries": [
                {"id": "Q01", "query": "서울 AI 지원", "split": "dev"},
                {"id": "Q02", "query": "수출 바우처", "split": "heldout"}
              ]
            }
            """.trimIndent(),
        )
        doReturn(trace("서울 AI 지원", listOf("BIZINFO:A"), listOf("BIZINFO:A")))
            .`when`(searchService)
            .searchWithTrace("서울 AI 지원", true, REFERENCE_DATE)
        doReturn(trace("수출 바우처", listOf("OTHER:A"), emptyList()))
            .`when`(searchService)
            .searchWithTrace("수출 바우처", true, REFERENCE_DATE)

        val output = directory.resolve("capture.json")
        runner(input, output).run()

        val capture = objectMapper.readTree(Files.readAllBytes(output))
        assertEquals("support-program-search-capture-v2", capture.get("schemaVersion").stringValue())
        assertEquals("real-catalog-v1", capture.get("querySet").get("name").stringValue())
        assertEquals(
            "eb70524c7e1a92a8250b525ceee8e1b432833aedc6730646b3a009bcb12b4356",
            capture.get("querySet").get("sha256").stringValue(),
        )
        assertEquals("2026-09-05T00:00:00Z", capture.get("capturedAt").stringValue())
        assertEquals("2026-09-05", capture.get("referenceDate").stringValue())
        assertTrue(capture.get("acceptingOnly").booleanValue())
        assertEquals(2, capture.get("catalog").get("presentProgramCount").intValue())
        assertEquals(1, capture.get("catalog").get("eligibleProgramCount").intValue())
        assertEquals(FINGERPRINT, capture.get("catalog").get("eligibleCatalogFingerprint").stringValue())
        assertEquals(20, capture.get("search").get("candidateLimit").intValue())
        assertEquals(5, capture.get("search").get("finalResultLimit").intValue())
        assertEquals("govbiz-support-program-ranking-v5", capture.get("search").get("scoringVersion").stringValue())
        assertEquals(2, capture.get("observations").size())
        assertEquals("Q01", capture.get("observations").get(0).get("id").stringValue())
        assertEquals("BIZINFO:A", capture.get("observations").get(0).get("candidateIds").get(0).stringValue())
        assertEquals("OTHER:A", capture.get("observations").get(1).get("candidateIds").get(0).stringValue())
        assertEquals(0, capture.get("observations").get(1).get("finalProgramIds").size())
        verify(searchService).searchWithTrace("서울 AI 지원", true, REFERENCE_DATE)
        verify(searchService).searchWithTrace("수출 바우처", true, REFERENCE_DATE)
    }

    @Test
    fun rejectsInvalidQuerySetsBeforeCallingSearchOrReplacingAnExistingCapture() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "invalid",
              "queries": [
                {"id": "Q01", "query": "지원사업", "split": "dev"},
                {"id": "Q01", "query": "다른 지원사업", "split": "unknown"}
              ]
            }
            """.trimIndent(),
        )
        val output = directory.resolve("capture.json")
        Files.writeString(output, "previous-capture", UTF_8)

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner(input, output).run()
        }

        assertTrue(exception.message.orEmpty().contains("duplicate query id"))
        assertEquals("previous-capture", Files.readString(output, UTF_8))
        verifyNoInteractions(searchService)
    }

    @Test
    fun keepsThePreviousCaptureWhenTheCatalogChangesMidCapture() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "real-catalog-v1",
              "queries": [
                {"id": "Q01", "query": "서울 AI 지원", "split": "dev"},
                {"id": "Q02", "query": "수출 바우처", "split": "heldout"}
              ]
            }
            """.trimIndent(),
        )
        val output = directory.resolve("capture.json")
        Files.writeString(output, "previous-capture", UTF_8)
        doReturn(trace("서울 AI 지원", listOf("BIZINFO:A"), listOf("BIZINFO:A")))
            .`when`(searchService)
            .searchWithTrace("서울 AI 지원", true, REFERENCE_DATE)
        doReturn(trace("수출 바우처", listOf("BIZINFO:B"), emptyList(), fingerprint = OTHER_FINGERPRINT))
            .`when`(searchService)
            .searchWithTrace("수출 바우처", true, REFERENCE_DATE)

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner(input, output).run()
        }

        assertTrue(exception.message.orEmpty().contains("catalog changed"))
        assertEquals("previous-capture", Files.readString(output, UTF_8))
        verify(searchService).searchWithTrace("서울 AI 지원", true, REFERENCE_DATE)
        verify(searchService).searchWithTrace("수출 바우처", true, REFERENCE_DATE)
    }

    @Test
    fun keepsThePreviousCaptureWhenASearchThrows() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "real-catalog-v1",
              "queries": [{"id": "Q01", "query": "서울 AI 지원", "split": "dev"}]
            }
            """.trimIndent(),
        )
        val output = directory.resolve("capture.json")
        Files.writeString(output, "previous-capture", UTF_8)
        doThrow(IllegalStateException("semantic search unavailable"))
            .`when`(searchService)
            .searchWithTrace("서울 AI 지원", true, REFERENCE_DATE)

        assertThrows(IllegalStateException::class.java) {
            runner(input, output).run()
        }

        assertEquals("previous-capture", Files.readString(output, UTF_8))
    }

    @Test
    fun rejectsAQueryLongerThanThePublicSearchLimit() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "invalid",
              "queries": [{"id": "Q01", "query": "${"가".repeat(501)}", "split": "dev"}]
            }
            """.trimIndent(),
        )

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner(input, directory.resolve("capture.json")).run()
        }

        assertTrue(exception.message.orEmpty().contains("at most 500"))
        assertFalse(Files.exists(directory.resolve("capture.json")))
        verifyNoInteractions(searchService)
    }

    @Test
    fun rejectsSurroundingWhitespaceBeforeHashingTheQuerySet() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "real-catalog-v1",
              "queries": [{"id": "Q01", "query": " 서울 AI 지원", "split": "dev"}]
            }
            """.trimIndent(),
        )

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner(input, directory.resolve("capture.json")).run()
        }

        assertTrue(exception.message.orEmpty().contains("surrounding whitespace"))
        verifyNoInteractions(searchService)
    }

    @Test
    fun rejectsMoreThanOneHundredQueriesBeforeCallingSearch() {
        val queries = (1..101).joinToString(",") { index ->
            "{\"id\":\"Q$index\",\"query\":\"지원사업 $index\",\"split\":\"dev\"}"
        }
        val input = writeQuerySet(
            """
            {"schemaVersion":"support-program-search-query-set-v1","name":"too-many","queries":[$queries]}
            """.trimIndent(),
        )

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner(input, directory.resolve("capture.json")).run()
        }

        assertTrue(exception.message.orEmpty().contains("at most 100"))
        verifyNoInteractions(searchService)
    }

    @Test
    fun rejectsAnInvalidSearchTraceBeforeReplacingThePreviousCapture() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "real-catalog-v1",
              "queries": [{"id": "Q01", "query": "서울 AI 지원", "split": "dev"}]
            }
            """.trimIndent(),
        )
        val output = directory.resolve("capture.json")
        Files.writeString(output, "previous-capture", UTF_8)
        doReturn(trace("서울 AI 지원", listOf("BIZINFO:A", "BIZINFO:A"), listOf("BIZINFO:A")))
            .`when`(searchService)
            .searchWithTrace("서울 AI 지원", true, REFERENCE_DATE)

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner(input, output).run()
        }

        assertTrue(exception.message.orEmpty().contains("candidateIds contain duplicates"))
        assertEquals("previous-capture", Files.readString(output, UTF_8))
    }

    @Test
    fun rejectsAFinalProgramThatWasNotASemanticCandidate() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "real-catalog-v1",
              "queries": [{"id": "Q01", "query": "서울 AI 지원", "split": "dev"}]
            }
            """.trimIndent(),
        )
        val output = directory.resolve("capture.json")
        Files.writeString(output, "previous-capture", UTF_8)
        doReturn(trace("서울 AI 지원", listOf("BIZINFO:A"), listOf("BIZINFO:B")))
            .`when`(searchService)
            .searchWithTrace("서울 AI 지원", true, REFERENCE_DATE)

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner(input, output).run()
        }

        assertTrue(exception.message.orEmpty().contains("must be candidateIds"))
        assertEquals("previous-capture", Files.readString(output, UTF_8))
    }

    @Test
    fun rejectsASearchTraceWithANonstandardSourceCode() {
        val input = writeQuerySet(
            """
            {
              "schemaVersion": "support-program-search-query-set-v1",
              "name": "real-catalog-v1",
              "queries": [{"id": "Q01", "query": "서울 AI 지원", "split": "dev"}]
            }
            """.trimIndent(),
        )
        val output = directory.resolve("capture.json")
        doReturn(trace("서울 AI 지원", listOf("other:A"), listOf("other:A")))
            .`when`(searchService)
            .searchWithTrace("서울 AI 지원", true, REFERENCE_DATE)

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner(input, output).run()
        }

        assertTrue(exception.message.orEmpty().contains("noncanonical"))
        assertFalse(Files.exists(output))
    }

    private fun runner(input: Path, output: Path) = SupportProgramSearchEvaluationCaptureCommandLineRunner(
        properties = SupportProgramSearchEvaluationCaptureProperties(
            querySetPath = input,
            outputPath = output,
            referenceDate = REFERENCE_DATE,
            acceptingOnly = true,
        ),
        searchService = searchService,
        objectMapper = objectMapper,
        clock = Clock.fixed(Instant.parse("2026-09-05T00:00:00Z"), ZoneOffset.UTC),
    )

    private fun trace(
        query: String,
        candidateIds: List<String>,
        finalProgramIds: List<String>,
        fingerprint: String = FINGERPRINT,
    ) = SupportProgramSearchTrace(
        result = SupportProgramSearchResult(query, emptyList()),
        candidateIds = candidateIds,
        finalProgramIds = finalProgramIds,
        presentProgramCount = 2,
        eligibleProgramCount = 1,
        eligibleCatalogFingerprint = fingerprint,
    )

    private fun writeQuerySet(value: String): Path = directory.resolve("query-set.json").also { path ->
        Files.writeString(path, value, UTF_8)
    }

    private companion object {
        val REFERENCE_DATE: LocalDate = LocalDate.of(2026, 9, 5)
        const val FINGERPRINT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        const val OTHER_FINGERPRINT = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
}
