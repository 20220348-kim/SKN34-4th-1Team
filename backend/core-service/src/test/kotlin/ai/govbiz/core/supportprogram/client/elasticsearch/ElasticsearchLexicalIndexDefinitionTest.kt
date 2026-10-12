package ai.govbiz.core.supportprogram.client.elasticsearch

import ai.govbiz.core.supportprogram.client.elasticsearch.config.ElasticsearchClientProperties
import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.core.io.ClassPathResource
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode

/**
 * 새 키워드 색인 v3 정의를 Docker 없이 검사합니다. 실제 Nori 분석·동의어 확장은
 * [ElasticsearchLexicalV3IntegrationTest]가 CI의 Elasticsearch로 확인합니다.
 */
class ElasticsearchLexicalIndexDefinitionTest {
    private val json = JsonMapper.builder().build()
    private val v2 = definition("v2")
    private val v3 = definition("v3")

    @Test
    fun v3ChangesOnlyTheUserDictionarySynonymsAndSchemaName() {
        val expected = v2.deepCopy() as ObjectNode
        val tokenizer = expected.path("settings").path("analysis").path("tokenizer").path("korean_words") as ObjectNode
        tokenizer.set("user_dictionary_rules", v3.path("settings").path("analysis").path("tokenizer").path("korean_words").path("user_dictionary_rules"))
        val filter = expected.path("settings").path("analysis").path("filter").path("program_synonyms") as ObjectNode
        filter.set("synonyms", v3.path("settings").path("analysis").path("filter").path("program_synonyms").path("synonyms"))
        (expected.path("mappings").path("_meta") as ObjectNode).put("govbizSchema", "support-program-lexical-v3")

        assertEquals(expected, v3)
        // 잘못된 규칙을 조용히 무시하지 않도록 v2와 같이 문자열 "false"를 유지합니다.
        assertEquals("false", v3.path("settings").path("analysis").path("filter").path("program_synonyms").path("lenient").asString())
    }

    @Test
    fun v3KeepsEveryV2RuleWithoutDuplicates() {
        val v2Words = userDictionary(v2)
        val v3Words = userDictionary(v3)
        assertEquals(v2Words, v3Words.take(v2Words.size))
        assertEquals(v3Words.size, v3Words.map { it.split(" ").first() }.toSet().size)
        val v2Synonyms = synonyms(v2)
        val v3Synonyms = synonyms(v3)
        assertEquals(v2Synonyms, v3Synonyms.take(v2Synonyms.size))
        assertEquals(v3Synonyms.size, v3Synonyms.toSet().size)
    }

    @Test
    fun abbreviationsAreDictionaryWordsSoNoriDoesNotSplitThemIntoUnrelatedWords() {
        val words = userDictionary(v3).map { it.split(" ").first() }.toSet()
        // "소진공"이 "소진+공"으로 나뉘면 "예산 소진" 공고와 맞고, "판로"는 "판+로(조사)"로 나뉘어 낱말이 사라집니다.
        listOf("중기부", "중진공", "소진공", "과기정통부", "코트라", "알앤디", "바우처", "바우쳐", "판로").forEach {
            assertTrue(it in words, it)
        }
        // 한쪽으로만 넓히는 규칙의 왼쪽(줄임말)은 모두 사전 낱말이어야 합니다.
        synonyms(v3).filter { "=>" in it }.flatMap { it.substringBefore("=>").split(",") }.map(String::trim)
            .filter { term -> term.any { it in '가'..'힣' } }
            .forEach { assertTrue(it in words, it) }
    }

    @Test
    fun longOfficialNamesHaveAFixedSplitSoSynonymParsingDoesNotDependOnPartOfSpeechGuesses() {
        // 규칙의 여러 낱말 쪽에서 품사 필터가 중간 낱말을 지우면 lenient=false 색인 생성이 실패하므로 나눔을 사전에 고정합니다.
        val compounds = userDictionary(v3).filter { " " in it }.associate { it.substringBefore(" ") to it.substringAfter(" ").split(" ") }
        val longTerms = synonyms(v3).flatMap { it.split("=>", ",") }.map(String::trim)
            .filter { term -> term.length >= 4 && term.all { it in '가'..'힣' } && term !in setOf("여행업체", "과기정통부") }
            .toSet()
        assertEquals(setOf("중소벤처기업부", "중소벤처기업진흥공단", "소상공인시장진흥공단", "과학기술정보통신부", "대한무역투자진흥공사",
            "연구개발", "정책자금"), longTerms)
        longTerms.forEach { term ->
            val parts = requireNotNull(compounds[term]) { term }
            assertEquals(term, parts.joinToString(""), term)
        }
    }

    @Test
    fun loanAndGrantRestaurantAndFoodServiceAndRegionsStayDistinct() {
        val rules = synonyms(v3)
        for ((left, right) in listOf("융자" to "보조금", "음식점" to "식품접객업소", "서울" to "울산")) {
            assertTrue(rules.none { left in it && right in it }, "$left/$right")
        }
    }

    @Test
    fun coreAndCatalogShipTheSameDefinitionsAndProductionStillUsesV2UntilTheDocumentedSwitch() {
        for (version in listOf("v2", "v3")) {
            val catalog = json.readTree(
                Files.readString(Path.of("../catalog-service/src/main/resources/elasticsearch/support-program-lexical-$version.json")),
            )
            assertEquals(definition(version), catalog, version)
        }
        assertEquals("govbiz-support-program-lexical-v2", ElasticsearchClientProperties(null, null, null, null, null).indexName)
    }

    private fun definition(version: String): JsonNode =
        ClassPathResource("elasticsearch/support-program-lexical-$version.json").inputStream.use(json::readTree)

    private fun userDictionary(definition: JsonNode): List<String> =
        definition.path("settings").path("analysis").path("tokenizer").path("korean_words")
            .path("user_dictionary_rules").toList().map { it.asString() }

    private fun synonyms(definition: JsonNode): List<String> =
        definition.path("settings").path("analysis").path("filter").path("program_synonyms")
            .path("synonyms").toList().map { it.asString() }
}
