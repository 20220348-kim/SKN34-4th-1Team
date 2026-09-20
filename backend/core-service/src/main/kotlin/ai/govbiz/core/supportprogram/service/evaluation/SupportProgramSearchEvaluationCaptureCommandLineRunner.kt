package ai.govbiz.core.supportprogram.service.evaluation

import ai.govbiz.core.supportprogram.facade.AiSupportProgramRankingFacade
import ai.govbiz.core.supportprogram.facade.SupportProgramRankingFacade
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchTrace
import ai.govbiz.core.supportprogram.service.evaluation.config.SupportProgramSearchEvaluationCaptureProperties
import ai.govbiz.core.supportprogram.service.evaluation.helper.SupportProgramSearchEvaluationFileHelper
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.util.HexFormat
import org.slf4j.LoggerFactory
import org.springframework.boot.CommandLineRunner
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper

/**
 * `evaluation-capture` 프로필에서만 질문 묶음을 실행하고 후보·최종 공고 ID를 하나의 JSON 파일로 기록합니다.
 * 모든 질문이 성공하기 전에는 대상 파일을 바꾸지 않습니다.
 */
class SupportProgramSearchEvaluationCaptureCommandLineRunner(
    private val properties: SupportProgramSearchEvaluationCaptureProperties,
    private val searchService: SupportProgramSearchService,
    private val objectMapper: ObjectMapper,
    private val clock: Clock,
) : CommandLineRunner {

    override fun run(vararg args: String) {
        val querySet = readQuerySet(properties.querySetPath)
        val observations = querySet.queries.map { query ->
            val trace = searchService.searchWithTrace(
                rawQuery = query.query,
                acceptingOnly = properties.acceptingOnly,
                referenceDate = properties.referenceDate,
            )
            validateTrace(query, trace)
            CaptureObservation(
                id = query.id,
                query = trace.result.query,
                split = query.split,
                candidateIds = trace.candidateIds,
                finalProgramIds = trace.finalProgramIds,
                trace = trace,
            )
        }
        val catalog = requireStableCatalog(observations)
        val capture = linkedMapOf<String, Any>(
            "schemaVersion" to CAPTURE_SCHEMA_VERSION,
            "querySet" to linkedMapOf(
                "name" to querySet.name,
                "sha256" to querySet.sha256,
            ),
            "capturedAt" to Instant.now(clock).toString(),
            "referenceDate" to properties.referenceDate.toString(),
            "acceptingOnly" to properties.acceptingOnly,
            "catalog" to linkedMapOf(
                "presentProgramCount" to catalog.presentProgramCount,
                "eligibleProgramCount" to catalog.eligibleProgramCount,
                "eligibleCatalogFingerprint" to catalog.eligibleCatalogFingerprint,
            ),
            "search" to linkedMapOf(
                "candidateLimit" to SupportProgramRankingFacade.MAX_CANDIDATES,
                "finalResultLimit" to SupportProgramRankingFacade.MAX_RESULTS,
                "scoringVersion" to AiSupportProgramRankingFacade.SCORING_VERSION,
            ),
            "observations" to observations.map { observation ->
                linkedMapOf(
                    "id" to observation.id,
                    "query" to observation.query,
                    "split" to observation.split,
                    "candidateIds" to observation.candidateIds,
                    "finalProgramIds" to observation.finalProgramIds,
                )
            },
        )
        SupportProgramSearchEvaluationFileHelper.writeAtomically(
            properties.outputPath,
            objectMapper.writeValueAsBytes(capture),
        )
        logger.info("지원사업 검색 평가 캡처 {}건을 {}에 기록했습니다.", observations.size, properties.outputPath)
    }

    private fun readQuerySet(path: Path): QuerySet {
        val root = objectMapper.readTree(Files.readAllBytes(path))
            ?: invalid("query set must contain a JSON object")
        if (!root.isObject) invalid("query set must be a JSON object")
        if (requiredText(root, "schemaVersion", "query set") != QUERY_SET_SCHEMA_VERSION) {
            invalid("unsupported query set schemaVersion")
        }
        val name = requiredText(root, "name", "query set")
        val values = root.get("queries") ?: invalid("query set requires queries")
        if (!values.isArray || values.size() == 0) {
            invalid("query set queries must be a nonempty array")
        }
        if (values.size() > MAX_QUERY_COUNT) {
            invalid("query set queries must contain at most $MAX_QUERY_COUNT items")
        }

        val seenIds = HashSet<String>()
        val queries = ArrayList<Query>(values.size())
        for (index in 0 until values.size()) {
            val value = values.get(index)
            if (!value.isObject) invalid("query set queries[$index] must be an object")
            val id = requiredText(value, "id", "query set queries[$index]")
            if (!seenIds.add(id)) invalid("query set has duplicate query id: $id")
            val query = requiredText(value, "query", "query set queries[$index]")
            if (query.length > MAX_QUERY_LENGTH) {
                invalid("query set queries[$index].query must be at most $MAX_QUERY_LENGTH characters")
            }
            val split = requiredText(value, "split", "query set queries[$index]")
            if (split !in SUPPORTED_SPLITS) {
                invalid("query set queries[$index].split must be dev or heldout")
            }
            queries += Query(id, query, split)
        }
        return QuerySet(
            name = name,
            sha256 = querySetSha256(queries),
            queries = java.util.List.copyOf(queries),
        )
    }

    /** Python 평가 도구와 동일하게 순서를 보존한 id/query/split compact JSON의 SHA-256을 계산합니다. */
    private fun querySetSha256(queries: List<Query>): String {
        val canonicalQueries = queries.map { query ->
            sortedMapOf(
                "id" to query.id,
                "query" to query.query,
                "split" to query.split,
            )
        }
        return sha256(objectMapper.writeValueAsBytes(canonicalQueries))
    }

    private fun requireStableCatalog(observations: List<CaptureObservation>): CatalogMetadata {
        val first = observations.firstOrNull()?.trace
            ?: invalid("query set queries must not be empty")
        if (observations.any { observation ->
                observation.trace.presentProgramCount != first.presentProgramCount ||
                    observation.trace.eligibleProgramCount != first.eligibleProgramCount ||
                    observation.trace.eligibleCatalogFingerprint != first.eligibleCatalogFingerprint
            }
        ) {
            invalid("catalog changed while capturing search evaluation; retry with synchronization disabled")
        }
        return CatalogMetadata(
            presentProgramCount = first.presentProgramCount,
            eligibleProgramCount = first.eligibleProgramCount,
            eligibleCatalogFingerprint = first.eligibleCatalogFingerprint,
        )
    }

    private fun validateTrace(query: Query, trace: SupportProgramSearchTrace) {
        if (trace.result.query != query.query) {
            invalid("search trace query does not match query set for ${query.id}")
        }
        if (trace.candidateIds.size > SupportProgramRankingFacade.MAX_CANDIDATES) {
            invalid("search trace candidateIds exceed candidateLimit for ${query.id}")
        }
        if (trace.finalProgramIds.size > SupportProgramRankingFacade.MAX_RESULTS) {
            invalid("search trace finalProgramIds exceed finalResultLimit for ${query.id}")
        }
        if (trace.candidateIds.toSet().size != trace.candidateIds.size) {
            invalid("search trace candidateIds contain duplicates for ${query.id}")
        }
        if (trace.finalProgramIds.toSet().size != trace.finalProgramIds.size) {
            invalid("search trace finalProgramIds contain duplicates for ${query.id}")
        }
        if (!trace.finalProgramIds.all(trace.candidateIds::contains)) {
            invalid("search trace finalProgramIds must be candidateIds for ${query.id}")
        }
        if ((trace.candidateIds + trace.finalProgramIds).any { identifier -> !isCanonicalProgramId(identifier) }) {
            invalid("search trace contains a noncanonical program ID for ${query.id}")
        }
    }

    private fun requiredText(node: JsonNode, field: String, owner: String): String {
        val value = node.get(field)
        if (value == null || !value.isString) invalid("$owner.$field must be a nonblank string")
        val text = value.stringValue()
        if (text.isBlank() || text != text.trim()) {
            invalid("$owner.$field must be a nonblank string without surrounding whitespace")
        }
        return text
    }

    private fun isCanonicalProgramId(value: String): Boolean {
        val separator = value.indexOf(':')
        if (separator !in 1 until value.lastIndex || value != value.trim()) return false
        return SOURCE_CODE_PATTERN.matches(value.substring(0, separator))
    }

    private fun sha256(value: ByteArray): String =
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value))

    private fun invalid(message: String): Nothing = throw IllegalArgumentException(message)

    private data class Query(val id: String, val query: String, val split: String)

    private data class QuerySet(val name: String, val sha256: String, val queries: List<Query>)

    private data class CatalogMetadata(
        val presentProgramCount: Int,
        val eligibleProgramCount: Int,
        val eligibleCatalogFingerprint: String,
    )

    private data class CaptureObservation(
        val id: String,
        val query: String,
        val split: String,
        val candidateIds: List<String>,
        val finalProgramIds: List<String>,
        val trace: SupportProgramSearchTrace,
    )

    private companion object {
        const val CAPTURE_SCHEMA_VERSION = "support-program-search-capture-v2"
        const val QUERY_SET_SCHEMA_VERSION = "support-program-search-query-set-v1"
        const val MAX_QUERY_LENGTH = 500
        const val MAX_QUERY_COUNT = 100
        val SOURCE_CODE_PATTERN = Regex("[A-Z][A-Z0-9_]{0,63}")
        val SUPPORTED_SPLITS = setOf("dev", "heldout")
        val logger = LoggerFactory.getLogger(SupportProgramSearchEvaluationCaptureCommandLineRunner::class.java)
    }
}
