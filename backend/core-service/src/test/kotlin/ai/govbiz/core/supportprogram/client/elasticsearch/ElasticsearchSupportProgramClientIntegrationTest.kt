package ai.govbiz.core.supportprogram.client.elasticsearch

import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.core.supportprogram.client.elasticsearch.config.ElasticsearchClientProperties
import ai.govbiz.core.supportprogram.client.elasticsearch.dto.ElasticsearchSupportProgramDocumentRequest
import ai.govbiz.core.supportprogram.client.elasticsearch.exception.ElasticsearchClientException
import ai.govbiz.core.supportprogram.client.elasticsearch.mapper.ElasticsearchSupportProgramDocumentMapper
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import java.net.URI
import java.nio.file.Path
import java.text.Normalizer
import java.time.Duration
import java.util.UUID
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.images.builder.ImageFromDockerfile
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.springframework.http.MediaType
import org.springframework.core.io.ClassPathResource
import org.springframework.web.client.RestClient
import tools.jackson.databind.json.JsonMapper

/** 스텁이 아닌 production Dockerfile의 ES + Nori로 검증합니다. 개발 색인은 접근하지 않습니다. */
@Testcontainers
class ElasticsearchSupportProgramClientIntegrationTest {
    private val json = JsonMapper.builder().build()
    private val rest = RestClient.builder().baseUrl("http://${elasticsearch.host}:${elasticsearch.getMappedPort(9200)}").build()
    private val index = "test-${UUID.randomUUID()}"
    private val client = ElasticsearchSupportProgramClient(rest,
        ElasticsearchClientProperties(URI.create("http://${elasticsearch.host}:${elasticsearch.getMappedPort(9200)}"), index, null, null, null), json)

    @Test
    fun koreanSentencesNormalizeAndRespectCurrentSourceVersionsWithRepeatableIndexing() {
        val old = document("same", "서울의 창업기업을 위한 기술개발 지원사업")
        val updated = document("same", "울산 제조업 공장설비 지원")
        val other = old.copy(id = "OTHER:same", versionId = "b".repeat(64))
        val decomposed = document("nfd", Normalizer.normalize("서울 창업기업 기술개발", Normalizer.Form.NFD))
        client.indexSnapshot(listOf(old, other, decomposed))
        client.indexSnapshot(listOf(old, other, decomposed))
        // 새 버전을 준비해도 이전 공개 버전과 다른 제공처는 덮어쓰지 않습니다.
        client.indexSnapshot(listOf(updated))
        val stored = json.readTree(rest.get().uri("/$index/_doc/${old.versionId}").retrieve().body(String::class.java)!!)
        assertEquals(Normalizer.normalize(old.text, Normalizer.Form.NFC), stored.path("_source").path("text").asString())
        assertEquals(listOf(old.id), client.search("서울에서 창업 지원사업을 찾습니다", listOf(old.reference()), 20))
        assertEquals(emptyList<String>(), client.search("울산", listOf(old.reference()), 20))
        assertEquals(listOf(updated.id), client.search("울산", listOf(updated.reference()), 20))
        assertEquals(setOf(old.id, other.id, decomposed.id),
            client.search("창업기업의 기술개발", listOf(old.reference(), other.reference(), decomposed.reference()), 20).toSet())
        assertEquals(emptyList<String>(), client.search("!!!🙂", listOf(old.reference()), 20))
        val count = rest.get().uri("/$index/_count").retrieve().body(String::class.java)!!
        assertEquals(4, json.readTree(count)["count"].asInt())
    }

    @Test
    fun aMissingVersionIsAnErrorEvenWhenTheQueryHasNoMatches() {
        val stored = document("stored", "서울 창업")
        val missing = document("missing", "울산")
        client.indexSnapshot(listOf(stored))
        assertThrows(ElasticsearchClientException::class.java) {
            client.search("없는단어", listOf(stored.reference(), missing.reference()), 20)
        }
        // 정기 복구가 누락만 추가하면 같은 조회가 정상 완료됩니다.
        client.indexSnapshot(listOf(stored, missing))
        assertEquals(emptyList<String>(), client.search("없는단어", listOf(stored.reference(), missing.reference()), 20))
    }

    @Test
    fun sameTextWithDifferentSortTimestampDoesNotOverwriteThePublishedTieBreak() {
        val original = catalogProgram("same", "동일 본문").copy(sortTimestamp = "2020")
        val old = ElasticsearchSupportProgramDocumentMapper.fromCatalog(original)
        val newer = ElasticsearchSupportProgramDocumentMapper.fromCatalog(original.copy(sortTimestamp = "2026"))
        assertEquals(old.contentHash, newer.contentHash)
        assertNotEquals(old.versionId, newer.versionId)
        assertEquals(SupportProgramIndexDocumentMapper.fromCatalog(original).contentHash, old.contentHash)
        client.indexSnapshot(listOf(old))
        client.indexSnapshot(listOf(newer))
        assertEquals(listOf(old.id), client.search("동일", listOf(old.reference()), 20))
    }

    @Test
    fun rejectsAnExistingIndexWithTheWrongAnalyzerAndHandlesAnEmptySnapshot() {
        rest.put().uri("/$index").contentType(MediaType.APPLICATION_JSON).body("""{"mappings":{"properties":{"text":{"type":"text"}}}}""")
            .retrieve().toBodilessEntity()
        assertThrows(ElasticsearchClientException::class.java) { client.indexSnapshot(listOf(document("one", "지원"))) }
        val emptyIndex = "test-${UUID.randomUUID()}"
        val emptyClient = ElasticsearchSupportProgramClient(rest, ElasticsearchClientProperties(null, emptyIndex, null, null, null), json)
        emptyClient.indexSnapshot(emptyList())
    }

    @Test
    fun preservesPlaceNamesAndSplitsDomainCompoundsWithoutStackedQueryTokens() {
        client.indexSnapshot(emptyList())
        assertEquals(listOf("횡성"), analyze("횡성", "korean"))
        assertEquals(listOf("횡성", "군"), analyze("횡성군", "korean"))
        // 단독 어절에서는 '의'가 별도 토큰으로 남을 수 있다. 모든 조사 제거가 아니라 업종명 보존을 검증한다.
        assertTrue(analyze("소상공인의", "korean_search").contains("소상공인"))
        assertEquals(listOf("횡성", "군", "소상공인"), analyze("횡성군 소상공인", "korean"))
        assertEquals(listOf("여수", "로"), analyze("여수로", "korean_search"))
        assertEquals(listOf("여수", "시"), analyze("여수시", "korean"))
        assertEquals(listOf("대출", "이자"), analyze("대출이자를", "korean_search"))
        assertEquals(listOf("대출", "이자"), analyze("대출이자", "korean"))
        assertEquals(listOf("현장", "애로", "기술", "지원"), analyze("현장애로기술지원", "korean"))
    }

    @Test
    fun expandsTravelBusinessSynonymsOnlyAtSearchTimeInBothDirections() {
        val agency = document("agency", "여행사")
        val business = document("business", "여행업체")
        val traveler = document("traveler", "관광객")
        val documents = listOf(agency, business, traveler)
        client.indexSnapshot(documents)
        assertEquals(listOf("여행사"), analyze("여행사", "korean"))
        assertEquals(listOf("여행업체"), analyze("여행업체", "korean"))
        assertEquals(setOf("여행사", "여행업체"), analyze("여행사", "korean_search").toSet())
        for (query in listOf("여행사", "여행업체")) {
            assertEquals(setOf(agency.id, business.id), client.search(query, documents.map { it.reference() }, 20).toSet())
        }
    }

    @Test
    fun placeNameAndParticleMatchesImproveRankingWithoutAnApplicantRegionFilter() {
        val documents = listOf(
            document("hoengseong", "횡성군 소상공인 대출이자 지원"),
            document("anyang", "안양시 소상공인 대출이자 지원"),
            document("yeosu", "여수시 단체관광객 유치 여행업체 인센티브 지원"),
            document("samcheok", "삼척시 단체관광객 유치 여행업체 인센티브 지원"),
        )
        client.indexSnapshot(documents)
        val references = documents.map { it.reference() }
        assertEquals(documents[0].id, client.search("횡성 소상공인의 대출이자를 지원", references, 20).first())
        assertEquals(documents[2].id, client.search("여수로 단체관광객을 유치하는 여행사", references, 20).first())
    }

    @Test
    fun doesNotTurnRelatedIndustriesFundingTypesOrLocationsIntoEquivalentTerms() {
        val documents = listOf(
            document("restaurant", "음식점"), document("food", "식품접객업소"),
            document("loan", "융자"), document("grant", "보조금"),
            document("seoul", "서울"), document("ulsan", "울산"),
        )
        client.indexSnapshot(documents)
        val references = documents.map { it.reference() }
        for ((query, expected) in listOf("음식점" to 0, "식품접객업소" to 1, "융자" to 2, "보조금" to 3, "서울" to 4, "울산" to 5)) {
            assertEquals(listOf(documents[expected].id), client.search(query, references, 20), query)
        }
    }

    @Test
    fun rejectsV1InsteadOfOverwritingItsIndexOrTreatingItAsV2() {
        val oldDefinition = ClassPathResource("elasticsearch/support-program-lexical-v1.json").inputStream.use { it.readBytes() }
        rest.put().uri("/$index").contentType(MediaType.APPLICATION_JSON).body(oldDefinition).retrieve().toBodilessEntity()
        assertThrows(ElasticsearchClientException::class.java) { client.indexSnapshot(emptyList()) }
        val mapping = json.readTree(rest.get().uri("/$index/_mapping").retrieve().body(String::class.java)!!)
        assertEquals("support-program-lexical-v1", mapping.path(index).path("mappings").path("_meta").path("govbizSchema").asString())
    }

    @Test
    fun v3KeepsAbbreviationsWholeAndExpandsThemOnlyAtSearchTime() {
        val v3 = createV3Index()
        assertEquals(listOf("중기부"), analyze("중기부", "korean", v3))
        assertEquals(listOf("소진공"), analyze("소진공", "korean", v3))
        assertTrue(analyze("판로개척", "korean", v3).contains("판로"))
        assertTrue(analyze("수출바우처", "korean", v3).contains("바우처"))
        assertTrue(analyze("중기부", "korean_search", v3).containsAll(analyze("중소벤처기업부", "korean", v3)))
        // v3 정의는 아직 운영 클라이언트가 쓰지 않습니다. 같은 이름의 v2 클라이언트는 v3 색인을 거부합니다.
        val v2Client = ElasticsearchSupportProgramClient(rest, ElasticsearchClientProperties(null, v3, null, null, null), json)
        assertThrows(ElasticsearchClientException::class.java) { v2Client.indexSnapshot(emptyList()) }
    }

    @Test
    fun v3FindsAbbreviationsAndRelatedFundingTermsButKeepsDistinctTermsApart() {
        val v3 = createV3Index()
        val texts = mapOf(
            "mss" to "중소벤처기업부 창업 지원 공고", "semas" to "소상공인시장진흥공단 경영 안정",
            "budget" to "예산 소진 시까지 접수", "kotra-name" to "대한무역투자진흥공사 해외 진출",
            "kotra-latin" to "KOTRA 수출 상담회", "rnd-latin" to "R&D 과제 모집", "rnd-korean" to "연구개발 과제 모집",
            "policy-fund" to "정책자금 안내", "loan" to "운전자금 융자", "grant" to "보조금 지급",
            "voucher" to "수출바우처 사업", "restaurant" to "음식점", "food" to "식품접객업소",
        )
        val body = texts.entries.joinToString("") { (id, text) ->
            json.writeValueAsString(mapOf("index" to mapOf("_id" to id))) + "\n" +
                json.writeValueAsString(mapOf("id" to id, "contentHash" to "h", "sortTimestamp" to "2026", "text" to text)) + "\n"
        }
        val bulk = rest.post().uri("/$v3/_bulk?refresh=true").contentType(MediaType.parseMediaType("application/x-ndjson"))
            .body(body.toByteArray(Charsets.UTF_8)).retrieve().body(String::class.java)!!
        assertFalse(json.readTree(bulk)["errors"].asBoolean())

        for ((query, expected) in listOf(
            "중기부" to setOf("mss"), "소진공" to setOf("semas"),
            "코트라" to setOf("kotra-name", "kotra-latin"), "KOTRA" to setOf("kotra-name", "kotra-latin"),
            "알앤디" to setOf("rnd-latin", "rnd-korean"), "R&D" to setOf("rnd-latin", "rnd-korean"),
            "연구개발" to setOf("rnd-latin", "rnd-korean"),
            "융자" to setOf("loan", "policy-fund"), "정책자금" to setOf("loan", "policy-fund"),
            "바우쳐" to setOf("voucher"), "보조금" to setOf("grant"), "음식점" to setOf("restaurant"),
        )) {
            assertEquals(expected, searchIds(v3, query), query)
        }
    }

    private fun createV3Index(): String {
        val name = "test-v3-${UUID.randomUUID()}"
        val definition = ClassPathResource("elasticsearch/support-program-lexical-v3.json").inputStream.use { it.readBytes() }
        // lenient=false라 잘못된 사전·동의어 규칙은 여기서 400으로 실패합니다.
        rest.put().uri("/$name").contentType(MediaType.APPLICATION_JSON).body(definition).retrieve().toBodilessEntity()
        return name
    }

    /** 운영 클라이언트와 같은 `match` OR 질의로 일치한 문서 ID만 셉니다. */
    private fun searchIds(indexName: String, query: String): Set<String> {
        val response = rest.post().uri("/$indexName/_search").contentType(MediaType.APPLICATION_JSON)
            .body(json.writeValueAsBytes(mapOf(
                "size" to 20, "_source" to listOf("id"),
                "query" to mapOf("match" to mapOf("text" to mapOf("query" to query, "operator" to "or", "zero_terms_query" to "none"))),
            ))).retrieve().body(String::class.java)!!
        return json.readTree(response).path("hits").path("hits").toList().map { it.path("_source").path("id").asString() }.toSet()
    }

    private fun analyze(text: String, analyzer: String, indexName: String = index): List<String> {
        val response = rest.post().uri("/$indexName/_analyze").contentType(MediaType.APPLICATION_JSON)
            .body(json.writeValueAsBytes(mapOf("text" to text, "analyzer" to analyzer)))
            .retrieve().body(String::class.java)!!
        return json.readTree(response)["tokens"].toList().map { it["token"].asString() }
    }

    private fun document(id: String, title: String): ElasticsearchSupportProgramDocumentRequest =
        ElasticsearchSupportProgramDocumentMapper.fromCatalog(catalogProgram(id).let { it.copy(program = it.program.copy(title = title, summary = "", targetDescription = "", categories = emptyList(), regions = emptyList())) })

    companion object {
        @Container
        @JvmField
        val elasticsearch = GenericContainer(ImageFromDockerfile().withDockerfile(Path.of("../../infrastructure/elasticsearch/Dockerfile")))
            .withEnv("discovery.type", "single-node")
            .withEnv("xpack.security.enabled", "false")
            .withEnv("xpack.ml.enabled", "false")
            .withEnv("ingest.geoip.downloader.enabled", "false")
            .withEnv("action.auto_create_index", "false")
            .withEnv("ES_JAVA_OPTS", "-Xms512m -Xmx512m")
            .withExposedPorts(9200)
            .waitingFor(Wait.forHttp("/_cluster/health").forStatusCode(200).withStartupTimeout(Duration.ofMinutes(3)))
    }
}
