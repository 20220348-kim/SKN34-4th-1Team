package ai.govbiz.core.supportprogram.service.evaluation

import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.evaluation.config.SupportProgramSearchEvaluationFixtureExportProperties
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.Path
import java.time.LocalDate
import java.security.MessageDigest
import java.util.HexFormat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.junit.jupiter.api.io.TempDir
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension
import tools.jackson.databind.json.JsonMapper

@ExtendWith(MockitoExtension::class)
class SupportProgramSearchEvaluationFixtureExportCommandLineRunnerTest {

    @TempDir
    private lateinit var directory: Path

    @Mock
    private lateinit var supportProgramRepository: SupportProgramRepository

    private val objectMapper = JsonMapper.builder().build()

    @Test
    fun exportsOnlyOpenProgramsAsASortedLabelReadyCatalogFixture() {
        val laterCanonicalId = catalogProgram("PBLN_Z", summary = "나중 공고")
            .copy(sortTimestamp = "2026-09-05 10:00:00")
        val earlierCanonicalId = catalogProgram("PBLN_A", summary = "먼저 공고")
            .copy(sortTimestamp = "2026-09-04 10:00:00")
        val closed = catalogProgram("PBLN_CLOSED")
            .copy(
                program = catalogProgram("PBLN_CLOSED").program.copy(
                    applicationPeriod = "접수 종료",
                    status = SupportProgramStatus.CLOSED,
                ),
            )
        val upcoming = catalogProgram("PBLN_UPCOMING")
            .copy(
                program = catalogProgram("PBLN_UPCOMING").program.copy(
                    applicationPeriod = "접수 예정",
                    status = SupportProgramStatus.UPCOMING,
                ),
            )
        doReturn(listOf(laterCanonicalId, closed, earlierCanonicalId, upcoming))
            .`when`(supportProgramRepository)
            .findSearchablePresent()

        val output = directory.resolve("fixture.json")
        Files.writeString(output, "previous-fixture", UTF_8)

        runner("bizinfo-20260905-v1", output).run()

        val fixture = objectMapper.readTree(Files.readAllBytes(output))
        assertEquals(
            setOf("name", "dataType", "referenceDate", "catalog", "docs", "cases"),
            fixture.propertyNames().asSequence().toSet(),
        )
        assertEquals("bizinfo-20260905-v1", fixture.get("name").stringValue())
        assertEquals("real_catalog_snapshot_unlabeled", fixture.get("dataType").stringValue())
        assertEquals("2026-09-05", fixture.get("referenceDate").stringValue())
        assertEquals(4, fixture.get("catalog").get("presentProgramCount").intValue())
        assertEquals(2, fixture.get("catalog").get("eligibleProgramCount").intValue())
        assertEquals(
            catalogFingerprint(listOf(earlierCanonicalId, laterCanonicalId)),
            fixture.get("catalog").get("eligibleCatalogFingerprint").stringValue(),
        )
        assertEquals(0, fixture.get("cases").size())

        val expectedPrograms = listOf(earlierCanonicalId, laterCanonicalId)
        assertEquals(2, fixture.get("docs").size())
        expectedPrograms.forEachIndexed { index, program ->
            val expectedDocument = SupportProgramIndexDocumentMapper.fromCatalog(program)
            val document = fixture.get("docs").get(index)
            assertEquals(
                setOf("id", "contentHash", "text", "sortTimestamp"),
                document.propertyNames().asSequence().toSet(),
            )
            assertEquals(expectedDocument.id, document.get("id").stringValue())
            assertEquals(expectedDocument.contentHash, document.get("contentHash").stringValue())
            assertEquals(expectedDocument.text, document.get("text").stringValue())
            assertEquals(program.sortTimestamp, document.get("sortTimestamp").stringValue())
        }
        verify(supportProgramRepository).findSearchablePresent()
    }

    @Test
    fun exportsSameRawIdsFromDifferentSourcesAsSeparateDocuments() {
        val bizInfo = catalogProgram("SHARED")
        val other = bizInfo.copy(
            program = bizInfo.program.copy(
                sourceCode = "OTHER",
                sourceName = "다른 제공처",
                sourceUrl = "https://other.example/program/SHARED",
            ),
        )
        doReturn(listOf(other, bizInfo)).`when`(supportProgramRepository).findSearchablePresent()
        val output = directory.resolve("fixture.json")

        runner("support-program-catalog-v1", output).run()

        val fixture = objectMapper.readTree(Files.readAllBytes(output))
        assertEquals(2, fixture.get("catalog").get("eligibleProgramCount").intValue())
        val documents = fixture.get("docs")
        assertEquals(
            listOf("BIZINFO:SHARED", "OTHER:SHARED"),
            listOf(
                documents.get(0).get("id").stringValue(),
                documents.get(1).get("id").stringValue(),
            ),
        )
        assertEquals(
            catalogFingerprint(listOf(bizInfo, other)),
            fixture.get("catalog").get("eligibleCatalogFingerprint").stringValue(),
        )
    }

    @Test
    fun keepsThePreviousFixtureWhenThereIsNoOpenProgramToLabel() {
        val closed = catalogProgram("PBLN_CLOSED")
            .copy(
                program = catalogProgram("PBLN_CLOSED").program.copy(
                    applicationPeriod = "접수 종료",
                    status = SupportProgramStatus.CLOSED,
                ),
            )
        val upcoming = catalogProgram("PBLN_UPCOMING")
            .copy(
                program = catalogProgram("PBLN_UPCOMING").program.copy(
                    applicationPeriod = "접수 예정",
                    status = SupportProgramStatus.UPCOMING,
                ),
            )
        doReturn(listOf(closed, upcoming)).`when`(supportProgramRepository).findSearchablePresent()
        val output = directory.resolve("fixture.json")
        Files.writeString(output, "previous-fixture", UTF_8)

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner("bizinfo-20260905-v1", output).run()
        }

        assertTrue(exception.message.orEmpty().contains("eligible"))
        assertEquals("previous-fixture", Files.readString(output, UTF_8))
        verify(supportProgramRepository).findSearchablePresent()
    }

    @Test
    fun usesTheEvaluationReferenceDateInsteadOfTheStatusCalculatedWhenTheCatalogWasRead() {
        val openOnReferenceDate = catalogProgram("PBLN_AT_REFERENCE_DATE")
            .copy(
                program = catalogProgram("PBLN_AT_REFERENCE_DATE").program.copy(
                    applicationPeriod = "2026-09-01 ~ 2026-09-06",
                    applicationStartDate = LocalDate.of(2026, 9, 1),
                    applicationEndDate = LocalDate.of(2026, 9, 6),
                    status = SupportProgramStatus.CLOSED,
                ),
            )
        val closedOnReferenceDate = catalogProgram("PBLN_BEFORE_REFERENCE_DATE")
            .copy(
                program = catalogProgram("PBLN_BEFORE_REFERENCE_DATE").program.copy(
                    applicationPeriod = "2026-08-01 ~ 2026-09-04",
                    applicationStartDate = LocalDate.of(2026, 8, 1),
                    applicationEndDate = LocalDate.of(2026, 9, 4),
                    status = SupportProgramStatus.OPEN,
                ),
            )
        doReturn(listOf(openOnReferenceDate, closedOnReferenceDate))
            .`when`(supportProgramRepository)
            .findSearchablePresent()

        val output = directory.resolve("fixture.json")
        runner("bizinfo-20260905-v1", output).run()

        val fixture = objectMapper.readTree(Files.readAllBytes(output))
        assertEquals(1, fixture.get("catalog").get("eligibleProgramCount").intValue())
        assertEquals("BIZINFO:PBLN_AT_REFERENCE_DATE", fixture.get("docs").get(0).get("id").stringValue())
    }

    @Test
    fun keepsThePreviousFixtureWhenCatalogLoadingFails() {
        val output = directory.resolve("fixture.json")
        Files.writeString(output, "previous-fixture", UTF_8)
        doThrow(IllegalStateException("database unavailable"))
            .`when`(supportProgramRepository)
            .findSearchablePresent()

        val exception = assertThrows(IllegalStateException::class.java) {
            runner("bizinfo-20260905-v1", output).run()
        }

        assertEquals("database unavailable", exception.message)
        assertEquals("previous-fixture", Files.readString(output, UTF_8))
        verify(supportProgramRepository).findSearchablePresent()
    }

    @Test
    fun keepsThePreviousFixtureWhenAnEligibleProgramHasNoStableSortTimestamp() {
        val withoutSortTimestamp = catalogProgram("PBLN_OPEN")
            .copy(sortTimestamp = "")
        doReturn(listOf(withoutSortTimestamp)).`when`(supportProgramRepository).findSearchablePresent()
        val output = directory.resolve("fixture.json")
        Files.writeString(output, "previous-fixture", UTF_8)

        val exception = assertThrows(IllegalArgumentException::class.java) {
            runner("bizinfo-20260905-v1", output).run()
        }

        assertTrue(exception.message.orEmpty().contains("sortTimestamp"))
        assertEquals("previous-fixture", Files.readString(output, UTF_8))
        verify(supportProgramRepository).findSearchablePresent()
    }

    @Test
    fun rejectsAnEmptyOrSurroundingWhitespaceFixtureName() {
        val output = directory.resolve("fixture.json")

        for (invalidName in listOf("", " ", " bizinfo-v1", "bizinfo-v1 ")) {
            val exception = assertThrows(IllegalArgumentException::class.java) {
                SupportProgramSearchEvaluationFixtureExportProperties(invalidName, REFERENCE_DATE, output)
            }
            assertTrue(exception.message.orEmpty().contains("name"))
        }

        val exception = assertThrows(IllegalArgumentException::class.java) {
            SupportProgramSearchEvaluationFixtureExportProperties("bizinfo-v1", REFERENCE_DATE, Path.of(""))
        }
        assertTrue(exception.message.orEmpty().contains("output"))
    }

    private fun runner(name: String, output: Path) = SupportProgramSearchEvaluationFixtureExportCommandLineRunner(
        properties = SupportProgramSearchEvaluationFixtureExportProperties(name, REFERENCE_DATE, output),
        supportProgramRepository = supportProgramRepository,
        objectMapper = objectMapper,
    )

    private fun catalogFingerprint(programs: List<CatalogSupportProgram>): String =
        HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(
                programs
                    .map(SupportProgramIndexDocumentMapper::fromCatalog)
                    .map { document -> "${document.id}:${document.contentHash}" }
                    .sorted()
                    .joinToString("\n")
                    .toByteArray(UTF_8),
            ),
        )

    private companion object {
        val REFERENCE_DATE: LocalDate = LocalDate.of(2026, 9, 5)
    }
}
