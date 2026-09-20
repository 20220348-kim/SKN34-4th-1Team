package ai.govbiz.core.applicationpreparation.service.backfill

import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import tools.jackson.databind.json.JsonMapper

/** 파일 읽기와 구조 검증만 수행한다. DB, 첨부 다운로드, OpenAI 호출이 없다. */
class ApplicationFormBackfillInput(private val json: ObjectMapper) {
    data class Report(val sha256: String, val schemaVersion: String, val programCount: Int,
        val analysisCounts: Map<String, Int>, val candidateFormCount: Int, val multipleFormProgramCount: Int, val inheritedMetadataProgramCount: Int)
    data class Validated(val report: Report, val programs: List<JsonNode>)

    fun read(path: Path, expectedHash: String, expectedCount: Int = 1459, expectedFound: Int = 676): Validated {
        require(Files.isRegularFile(path)) { "Backfill input is missing" }
        val bytes = Files.readAllBytes(path)
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        require(hash.equals(expectedHash, ignoreCase = true)) { "Backfill SHA-256 mismatch" }
        val root = json.readTree(bytes)
        require(root.path("schemaVersion").asString() == "application-form-openai-analysis-v2") { "Unsupported backfill schema" }
        val array = root.path("programs")
        require(array.isArray && array.size() == expectedCount) { "Backfill program count mismatch" }
        val programs = array.toList()
        val identities = mutableSetOf<Pair<String, String>>()
        val states = setOf("FORM_FOUND", "NO_FORM", "NOT_ELIGIBLE", "FAILED", "UNKNOWN_AFTER_START")
        var inheritedMetadata = 0
        programs.forEach { program ->
            val source = program.path("sourceCode").asString()
            val id = program.path("sourceProgramId").asString()
            require(Regex("[A-Z][A-Z0-9_]{0,63}").matches(source) && id.isNotBlank() && id.length <= 255)
            require(identities.add(source to id)) { "Duplicate backfill program identity" }
            val analysis = program.path("aiAnalysis")
            // v2 재검사 성공 558건은 공통 model/prompt와 originalAiAnalysis의 계약을 상속한다.
            // 파일 자체는 수정하지 않으며, 상속 근거가 없거나 서로 다르면 거부한다.
            if (listOf("contractVersion", "model", "promptVersion").any { analysis.path(it).isMissingNode || analysis.path(it).isNull }) {
                val original = program.path("originalAiAnalysis")
                require(original.path("sourceCode").asString() == source && original.path("sourceProgramId").asString() == id)
                require(original.path("model").asString() == root.path("originalReport").path("model").asString())
                require(original.path("promptVersion").asString() == root.path("originalReport").path("promptVersion").asString())
                listOf("contractVersion", "model", "promptVersion").forEach { key ->
                    if (analysis.path(key).isMissingNode || analysis.path(key).isNull) {
                        (analysis as tools.jackson.databind.node.ObjectNode).put(key, original.path(key).asString())
                    }
                }
                inheritedMetadata++
            }
            require(analysis.path("sourceCode").asString() == source && analysis.path("sourceProgramId").asString() == id)
            require(analysis.path("status").asString() in states) { "Unknown final analysis status" }
            require(analysis.path("contractVersion").asString() == "application-form-discovery-v1")
            require(analysis.path("model").asString().isNotBlank())
            require(Regex("sha256:[0-9a-f]{64}").matches(analysis.path("promptVersion").asString()))
            require(analysis.path("forms").isArray)
            if (analysis.path("status").asString() == "FORM_FOUND") {
                require(analysis.path("forms").size() > 0)
                val indices = analysis.path("forms").toList().map { it.path("documentIndex").asInt(-1) }
                require(indices.distinct().size == indices.size && indices.all { it >= 0 && it < program.path("files").size() })
            }
            program.path("files").forEach { file ->
                require(Regex("[0-9a-f]{64}").matches(file.path("sha256").asString()))
            }
        }
        val counts = programs.groupingBy { it.path("aiAnalysis").path("status").asString() }.eachCount().toSortedMap()
        require((counts["FORM_FOUND"] ?: 0) == expectedFound) { "Backfill FORM_FOUND count mismatch" }
        val found = programs.filter { it.path("aiAnalysis").path("status").asString() == "FORM_FOUND" }
        return Validated(Report(hash, root.path("schemaVersion").asString(), programs.size, counts,
            found.sumOf { it.path("aiAnalysis").path("forms").size() },
            found.count { it.path("aiAnalysis").path("forms").size() > 1 }, inheritedMetadata), programs)
    }
    companion object {
        @JvmStatic fun main(args: Array<String>) {
            require(args.size == 2) { "Usage: applicationFormBackfillDryRun -PinputFile=<path> -PinputSha256=<hash>" }
            val json = JsonMapper.builder().build()
            println(json.writeValueAsString(ApplicationFormBackfillInput(json).read(Path.of(args[0]), args[1]).report))
        }
    }
}
