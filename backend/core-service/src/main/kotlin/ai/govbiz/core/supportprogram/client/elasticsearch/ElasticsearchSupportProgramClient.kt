package ai.govbiz.core.supportprogram.client.elasticsearch

import ai.govbiz.core.supportprogram.client.elasticsearch.config.ElasticsearchClientProperties
import ai.govbiz.core.supportprogram.client.elasticsearch.dto.ElasticsearchSupportProgramDocumentRequest
import ai.govbiz.core.supportprogram.client.elasticsearch.dto.ElasticsearchSupportProgramReferenceRequest
import ai.govbiz.core.supportprogram.client.elasticsearch.exception.ElasticsearchClientException
import ai.govbiz.core.supportprogram.helper.SupportProgramIndexTextHelper
import java.text.Normalizer
import java.nio.charset.StandardCharsets
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.core.io.ClassPathResource
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import org.springframework.web.client.RestClientResponseException
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper

/** 공개된 문서 버전만 Nori·BM25로 검색합니다. 미완성 색인·부분 응답은 정상 결과로 숨기지 않습니다. */
@Component
class ElasticsearchSupportProgramClient(
    @param:Qualifier("elasticsearchRestClient") private val restClient: RestClient,
    private val properties: ElasticsearchClientProperties,
    private val mapper: ObjectMapper,
) {
    private val indexPath get() = "/${properties.indexName}"
    private val definition by lazy {
        ClassPathResource("elasticsearch/support-program-lexical-v2.json").inputStream.use(mapper::readTree)
    }

    /** 불변 버전을 추가할 뿐 기존 버전을 삭제하지 않습니다. 전체가 검색에 보인 뒤에만 성공합니다. */
    fun indexSnapshot(documents: List<ElasticsearchSupportProgramDocumentRequest>) = guarded {
        val references = documents.map { it.reference() }
        validateReferences(references)
        ensureIndex()
        for (batch in documents.chunked(64)) {
            val existing = json(HttpMethod.POST, "/_mget", mapOf(
                "docs" to batch.map { mapOf("_id" to it.versionId, "_source" to listOf("id", "contentHash", "sortTimestamp")) },
            ))["docs"] ?: invalid()
            if (!existing.isArray || existing.size() != batch.size) invalid()
            val missing = batch.filterIndexed { index, document ->
                val item = existing[index]
                if (item["_id"]?.asString() != document.versionId || item.has("error")) invalid()
                if (item["found"]?.isBoolean != true) invalid()
                if (item["found"].asBoolean()) {
                    validateSource(item["_source"], document.reference())
                    false
                } else true
            }
            if (missing.isNotEmpty()) {
                val body = buildString {
                    for (document in missing) {
                        append(mapper.writeValueAsString(mapOf("create" to mapOf("_id" to document.versionId))))
                        append('\n')
                        append(mapper.writeValueAsString(mapOf(
                            "id" to document.id, "contentHash" to document.contentHash,
                            "sortTimestamp" to document.sortTimestamp,
                            "text" to Normalizer.normalize(document.text, Normalizer.Form.NFC),
                        )))
                        append('\n')
                    }
                }
                val result = json(HttpMethod.POST, "/_bulk", body, MediaType.parseMediaType("application/x-ndjson"))
                val items = result["items"] ?: invalid()
                if (!items.isArray || items.size() != missing.size) invalid()
                items.forEachIndexed { index, item ->
                    val created = item["create"] ?: invalid()
                    if (created["_id"]?.asString() != missing[index].versionId) invalid()
                    when (created["status"]?.asInt()) {
                        201 -> if (created.has("error")) invalid()
                        // 동일 버전의 동시 준비만 허용합니다. 현재 공개 버전을 덮어쓰지 않습니다.
                        409 -> if (created.path("error").path("type").asString() != "version_conflict_engine_exception") invalid()
                        else -> invalid()
                    }
                }
            }
        }
        checkShards(json(HttpMethod.POST, "/_refresh"))
        val count = json(HttpMethod.POST, "/_count", mapOf("query" to versionFilter(references)))
        checkShards(count)
        if (count["count"]?.asInt() != documents.size) invalid()
    }

    fun search(query: String, references: List<ElasticsearchSupportProgramReferenceRequest>, limit: Int): List<String> = guarded {
        require(query.isNotBlank())
        require(limit in 1..20)
        validateReferences(references)
        if (references.isEmpty()) return@guarded emptyList()
        val filter = versionFilter(references)
        val result = json(HttpMethod.POST, "/_search", mapOf(
            "size" to limit, "track_total_hits" to true,
            "_source" to listOf("id", "contentHash", "sortTimestamp"),
            "query" to mapOf("bool" to mapOf(
                "filter" to listOf(filter),
                "must" to listOf(mapOf("match" to mapOf("text" to mapOf(
                    "query" to Normalizer.normalize(query, Normalizer.Form.NFC), "operator" to "or",
                    "zero_terms_query" to "none",
                )))),
            )),
            "sort" to listOf(mapOf("_score" to "desc"), mapOf("sortTimestamp" to "desc"), mapOf("id" to "asc")),
            // 같은 검색 시점에 대상 전체의 가시성을 확인해 누락을 '일치 없음'으로 오인하지 않습니다.
            "aggs" to mapOf("catalog" to mapOf(
                "global" to emptyMap<String, Any>(),
                "aggs" to mapOf("versions" to mapOf("filter" to filter)),
            )),
        ))
        checkShards(result)
        if (result["timed_out"]?.isBoolean != true || result["timed_out"].asBoolean()) invalid()
        if (result.path("aggregations").path("catalog").path("versions").path("doc_count").asInt(-1) != references.size) invalid()
        val total = result.path("hits").path("total")
        if (total.path("relation").asString() != "eq" || !total.path("value").isIntegralNumber) invalid()
        val matchCount = total["value"].asInt()
        if (matchCount !in 0..references.size) invalid()
        val hits = result.path("hits").path("hits")
        if (!hits.isArray || hits.size() != minOf(limit, matchCount)) invalid()
        val allowed = references.associateBy { it.versionId }
        val seen = HashSet<String>()
        var previousScore = Double.POSITIVE_INFINITY
        hits.toList().map { hit ->
            val reference = allowed[hit.path("_id").asString()] ?: invalid()
            if (!seen.add(reference.id)) invalid()
            validateSource(hit["_source"], reference)
            val scoreNode = hit["_score"] ?: invalid()
            if (!scoreNode.isNumber) invalid()
            val score = scoreNode.asDouble()
            if (!score.isFinite() || score < 0 || score > previousScore) invalid()
            previousScore = score
            reference.id
        }
    }

    private fun ensureIndex() {
        val mapping = try {
            json(HttpMethod.GET, "/_mapping")
        } catch (exception: RestClientResponseException) {
            if (exception.statusCode.value() != 404) throw exception
            try {
                val created = json(HttpMethod.PUT, "", definition)
                if (!created.path("acknowledged").asBoolean()) invalid()
            } catch (conflict: RestClientResponseException) {
                if (conflict.statusCode.value() != 400 ||
                    mapper.readTree(conflict.responseBodyAsString).path("error").path("type").asString() != "resource_already_exists_exception"
                ) throw conflict
            }
            json(HttpMethod.GET, "/_mapping")
        }
        // 이름만 같은 다른 스키마·분석기의 색인을 사용하지 않습니다.
        if (mapping.size() != 1 || mapping.path(properties.indexName).path("mappings") != definition["mappings"]) invalid()
        val settings = json(HttpMethod.GET, "/_settings").path(properties.indexName).path("settings").path("index")
        if (settings.path("analysis") != definition.path("settings").path("analysis")) invalid()
        val similarity = settings.path("similarity").path("lexical_bm25")
        if (similarity.path("type").asString() != "BM25" || similarity.path("k1").asDouble() != 1.2 ||
            similarity.path("b").asDouble() != 0.75 || !similarity.path("discount_overlaps").asBoolean()
        ) invalid()
    }

    private fun versionFilter(references: List<ElasticsearchSupportProgramReferenceRequest>): Map<String, Any> =
        if (references.isEmpty()) mapOf("match_none" to emptyMap<String, Any>())
        else mapOf("ids" to mapOf("values" to references.map { it.versionId }))

    private fun validateReferences(references: List<ElasticsearchSupportProgramReferenceRequest>) {
        require(references.size <= SupportProgramIndexTextHelper.MAX_DOCUMENTS)
        require(references.map { it.id }.toSet().size == references.size)
        require(references.map { it.versionId }.toSet().size == references.size)
    }

    private fun validateSource(source: JsonNode?, reference: ElasticsearchSupportProgramReferenceRequest) {
        if (source?.get("id")?.asString() != reference.id || source["contentHash"]?.asString() != reference.contentHash ||
            source["sortTimestamp"]?.asString() != reference.sortTimestamp
        ) invalid()
    }

    private fun checkShards(result: JsonNode) {
        val shards = result.path("_shards")
        val total = shards.path("total").asInt(-1)
        val successful = shards.path("successful").asInt(-1)
        if (total < 1 || successful != total || shards.path("failed").asInt(-1) != 0) invalid()
    }

    private fun json(method: HttpMethod, suffix: String, body: Any? = null, mediaType: MediaType = MediaType.APPLICATION_JSON): JsonNode {
        val request = restClient.method(method).uri(indexPath + suffix)
        // application/x-ndjson의 String converter 기본 인코딩에 의존하면 한글이 '?'로 손실됩니다.
        if (body != null) request.contentType(mediaType).body(
            (if (body is String) body else mapper.writeValueAsString(body)).toByteArray(StandardCharsets.UTF_8),
        )
        val response = request.retrieve().body(String::class.java) ?: invalid()
        return mapper.readTree(response) ?: invalid()
    }

    private inline fun <T> guarded(action: () -> T): T = try {
        action()
    } catch (exception: ElasticsearchClientException) {
        throw exception
    } catch (exception: RuntimeException) {
        throw ElasticsearchClientException("Support program lexical index operation failed", exception)
    }

    private fun invalid(): Nothing = throw ElasticsearchClientException("Support program lexical index violated its contract")
}
