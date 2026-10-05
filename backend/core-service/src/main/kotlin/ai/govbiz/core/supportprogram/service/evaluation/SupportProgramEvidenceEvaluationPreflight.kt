package ai.govbiz.core.supportprogram.service.evaluation

import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceChunk
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceChunker
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.HexFormat
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper

/** 저장된 공식 자료를 실제 Core 청커로 점검한다. Spring·DB·HTTP·모델을 시작하지 않는다. */
object SupportProgramEvidenceEvaluationPreflight {
    private val mapper = JsonMapper.builder().build()

    @JvmStatic
    fun main(args: Array<String>) {
        require(args.size == 2) { "Usage: <official RAG fixture.json> <new report.json>" }
        val report = inspect(Files.readAllBytes(Path.of(args[0])))
        Files.write(Path.of(args[1]), mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(report), CREATE_NEW)
        println("Core 청킹 사전 점검 완료. 실제 검색·모델 호출·사람 검토는 수행하지 않았습니다.")
    }

    fun inspect(raw: ByteArray): Map<String, Any> {
        val fixture = mapper.readTree(raw)
        require(text(fixture, "schemaVersion") == "support-program-rag-fixture-v2")
        require(text(fixture, "scope") == "source-chunks-retrieval-answer")
        require(text(fixture, "dataType") == "official-html-snapshot")
        require(text(fixture, "referenceSource") == "ai-authored-not-human-reviewed")
        val documents = array(fixture, "documents")
        require(documents.size in 1..50) { "Expected 1..50 official documents" }
        val actual = linkedMapOf<String, List<SupportProgramEvidenceChunk>>()
        val documentReports = documents.map { document ->
            val id = text(document, "documentId")
            val source = requireNotNull(document["source"])
            require(text(source, "sourceCode") == "BIZINFO")
            val programId = text(source, "sourceProgramId")
            require(programId.matches(Regex("PBLN_[0-9]+")) && id == "BIZINFO:$programId")
            require(id !in actual) { "Duplicate document ID" }
            val url = text(document, "sourceUrl")
            require(url == "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=$programId")
            require(text(source, "scope") == "frozen-title-and-body-html-no-attachments")
            val content = text(document, "content")
            val chunks = SupportProgramEvidenceChunker.chunk(
                SupportProgramSourceDocument(
                    sourceCode = "BIZINFO", sourceProgramId = programId, sourceUrl = url,
                    content = content, contentHash = text(document, "contentHash"),
                    fetchedAt = OffsetDateTime.parse(text(source, "collectedAt")).toLocalDateTime(),
                ),
            )
            actual[id] = chunks
            linkedMapOf(
                "documentId" to id,
                "sourceUrl" to url,
                "sourceContentHash" to text(document, "contentHash"),
                "sourceCollectedAt" to text(source, "collectedAt"),
                "sourceScope" to text(source, "scope"),
                "sourceUtf16Length" to content.length,
                "previousChunkVersion" to text(document, "chunkVersion"),
                "previousChunkCount" to array(document, "chunks").size,
                "coreChunkCount" to chunks.size,
                "retrievedChunkLimit" to minOf(chunks.size, AiSupportProgramEvidenceFacade.MAX_RETRIEVED_CHUNKS),
                "requiresRankingSelection" to (chunks.size > AiSupportProgramEvidenceFacade.MAX_RETRIEVED_CHUNKS),
                "chunks" to chunks.map { chunk ->
                    linkedMapOf(
                        "id" to chunk.id, "documentId" to chunk.documentId, "order" to chunk.order,
                        "contentHash" to chunk.contentHash, "text" to chunk.text,
                    )
                },
            )
        }
        val ids = mutableSetOf<String>()
        val cases = array(fixture, "cases")
        require(cases.isNotEmpty()) { "At least one case is required" }
        val caseReports = cases.map { case ->
            val id = text(case, "id")
            require(ids.add(id)) { "Duplicate case ID" }
            val documentId = text(case, "documentId")
            val chunks = requireNotNull(actual[documentId]) { "Unknown case document" }
            val status = text(case, "expectedStatus")
            require(status in setOf("ANSWERED", "INSUFFICIENT_EVIDENCE"))
            val references = array(case, "expectedEvidence").map { evidence ->
                val quote = text(evidence, "quote")
                linkedMapOf(
                    "quote" to quote,
                    "matchingCoreChunkIds" to chunks.filter { quote in it.text }.map { it.id },
                )
            }
            require((status == "ANSWERED") == references.isNotEmpty()) { "Status/reference mismatch" }
            val mapped = references.all { (it["matchingCoreChunkIds"] as List<*>).size == 1 }
            linkedMapOf(
                "caseId" to id, "documentId" to documentId, "question" to text(case, "question"),
                "expectedStatus" to status, "references" to references,
                "referencesMapToUniqueCoreChunks" to mapped,
                "canMeasureRankingSelection" to (status == "ANSWERED" && mapped &&
                    chunks.size > AiSupportProgramEvidenceFacade.MAX_RETRIEVED_CHUNKS),
            )
        }
        val eligible = caseReports.count { it["canMeasureRankingSelection"] == true }
        return linkedMapOf(
            "schemaVersion" to "core-evidence-preflight-v1",
            "inputFixtureSha256" to sha256(raw),
            "datasetVersion" to text(fixture, "datasetVersion"),
            "coreChunkerClassSha256" to SupportProgramEvidenceChunker::class.java
                .getResourceAsStream("SupportProgramEvidenceChunker.class")!!.use { sha256(it.readAllBytes()) },
            "retrievalLimit" to AiSupportProgramEvidenceFacade.MAX_RETRIEVED_CHUNKS,
            "rankingSelectionCaseCount" to eligible,
            "rankingSelectionCoverage" to if (eligible == 0) "INSUFFICIENT" else "AVAILABLE",
            "referenceRemappingRequired" to caseReports.any { it["referencesMapToUniqueCoreChunks"] == false },
            "modelApiCalls" to 0,
            "coreHttpExecuted" to false,
            "sourceFetchExecuted" to false,
            "attachmentsIncluded" to false,
            "referenceSource" to "ai-authored-not-human-reviewed",
            "baselineEligible" to false,
            "documents" to documentReports,
            "cases" to caseReports,
        )
    }

    private fun text(node: JsonNode, field: String): String {
        val value = node[field]
        require(value != null && value.isString && value.stringValue().isNotBlank()) { "Required text: $field" }
        return value.stringValue()
    }

    private fun array(node: JsonNode, field: String): List<JsonNode> {
        val value = node[field]
        require(value != null && value.isArray) { "Required array: $field" }
        return value.toList()
    }

    private fun sha256(value: ByteArray): String =
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value))
}
