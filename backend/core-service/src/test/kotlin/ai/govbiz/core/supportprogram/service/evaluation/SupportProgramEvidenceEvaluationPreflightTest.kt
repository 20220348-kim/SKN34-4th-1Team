package ai.govbiz.core.supportprogram.service.evaluation

import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode

class SupportProgramEvidenceEvaluationPreflightTest {
    @TempDir lateinit var directory: Path
    private val mapper = JsonMapper.builder().build()
    private val fixture = Path.of("../../evaluation/support-program-evidence/runs/official-rag-20261006-v2/fixture.json")

    @Test
    fun officialSixCasesDoNotMeasureTopFiveRankingWithTheActualCoreChunker() {
        val raw = Files.readAllBytes(fixture)
        val report = mapper.valueToTree<JsonNode>(SupportProgramEvidenceEvaluationPreflight.inspect(raw))

        assertEquals("INSUFFICIENT", report["rankingSelectionCoverage"].asString())
        assertEquals(0, report["rankingSelectionCaseCount"].asInt())
        assertEquals(listOf(1, 1), report["documents"].toList().map { it["coreChunkCount"].asInt() })
        assertEquals(listOf(21, 17), report["documents"].toList().map { it["previousChunkCount"].asInt() })
        assertEquals(6, report["cases"].size())
        assertFalse(report["referenceRemappingRequired"].asBoolean())
        assertFalse(report["baselineEligible"].asBoolean())
        assertFalse(report["coreHttpExecuted"].asBoolean())
        assertFalse(report["sourceFetchExecuted"].asBoolean())
        assertEquals(0, report["modelApiCalls"].asInt())
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(raw)),
            report["inputFixtureSha256"].asString())
        val firstChunk = report["documents"][0]["chunks"][0]["text"].asString()
        assertTrue("중소ㆍ중견 제조기업" in firstChunk)
        assertTrue("자발적으로 고도화를 추진" in firstChunk)
    }

    @Test
    fun missingReferencesAreFlaggedWithoutInventingNewLabelsOrChangingInput() {
        val root = mapper.readTree(Files.readAllBytes(fixture))
        (root["cases"][0]["expectedEvidence"][0] as ObjectNode).put("quote", "원문에 없는 검토 조건")
        val raw = mapper.writeValueAsBytes(root)
        val copy = raw.copyOf()
        val report = mapper.valueToTree<JsonNode>(SupportProgramEvidenceEvaluationPreflight.inspect(raw))
        assertTrue(report["referenceRemappingRequired"].asBoolean())
        assertFalse(report["cases"][0]["referencesMapToUniqueCoreChunks"].asBoolean())
        assertEquals("ai-authored-not-human-reviewed", report["referenceSource"].asString())
        assertArrayEquals(copy, raw)
    }

    @Test
    fun recognizesRankingCandidatesButDoesNotClaimModelQuality() {
        val root = mapper.readTree(Files.readAllBytes(fixture))
        val document = root["documents"][0] as ObjectNode
        val content = document["content"].asString() + "\n\n" + List(8) { "검증용 긴 문단 " + "가".repeat(1_300) }.joinToString("\n\n")
        document.put("content", content)
        document.put("contentHash", SupportProgramContentHashHelper.sha256(content))
        val report = mapper.valueToTree<JsonNode>(SupportProgramEvidenceEvaluationPreflight.inspect(mapper.writeValueAsBytes(root)))
        assertEquals("AVAILABLE", report["rankingSelectionCoverage"].asString())
        assertEquals(1, report["rankingSelectionCaseCount"].asInt())
        assertFalse(report["baselineEligible"].asBoolean())
        assertFalse(report.has("retrievalRecall"))
        assertEquals(0, report["modelApiCalls"].asInt())
    }

    @Test
    fun rejectsChangedContentHashAndUnknownCaseDocuments() {
        val root = mapper.readTree(Files.readAllBytes(fixture))
        (root["documents"][0] as ObjectNode).put("content", "바뀐 원문")
        assertThrows(IllegalArgumentException::class.java) {
            SupportProgramEvidenceEvaluationPreflight.inspect(mapper.writeValueAsBytes(root))
        }
        val another = mapper.readTree(Files.readAllBytes(fixture))
        (another["cases"][0] as ObjectNode).put("documentId", "BIZINFO:PBLN_999999")
        assertThrows(IllegalArgumentException::class.java) {
            SupportProgramEvidenceEvaluationPreflight.inspect(mapper.writeValueAsBytes(another))
        }
    }

    @Test
    fun cliNeverOverwritesAnExistingReport() {
        val output = directory.resolve("preflight.json")
        Files.writeString(output, "previous evidence")
        assertThrows(FileAlreadyExistsException::class.java) {
            SupportProgramEvidenceEvaluationPreflight.main(arrayOf(fixture.toString(), output.toString()))
        }
        assertEquals("previous evidence", Files.readString(output))
    }
}
