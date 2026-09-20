package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramIndexClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexReferenceRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexSearchRequest
import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.client.elasticsearch.ElasticsearchSupportProgramClient
import ai.govbiz.core.supportprogram.client.elasticsearch.dto.ElasticsearchSupportProgramReferenceRequest
import ai.govbiz.core.supportprogram.client.elasticsearch.mapper.ElasticsearchSupportProgramDocumentMapper
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** 현재 DB 공고 버전에서 검증한 의미 검색과 키워드 순위를 결합해 점수화 후보를 고릅니다. */
@Component
class AiSupportProgramRetrievalFacade(
    private val client: AiSupportProgramIndexClient,
    private val lexicalClient: ElasticsearchSupportProgramClient,
) {
    // 한 개의 불변 스냅샷만 게시합니다. 동시 준비가 중복될 수 있지만 검색이나 HTTP 호출에 락을 걸지 않습니다.
    @Volatile
    private var preparedCatalog: PreparedCatalog? = null

    fun retrieve(query: String, eligiblePrograms: List<CatalogSupportProgram>): List<CatalogSupportProgram> {
        require(query.isNotBlank()) { "query must not be blank" }
        if (eligiblePrograms.isEmpty()) return emptyList()
        if (eligiblePrograms.size > SupportProgramIndexDocumentMapper.MAX_DOCUMENTS) {
            throw AiServiceCallException.unavailable(null)
        }
        val prepared = timed("document_prepare") { prepare(eligiblePrograms) }
        val programsById = prepared.programsById
        // 키워드 색인 장애는 유료 질의 임베딩을 요청하기 전에 발견합니다.
        val keywordIds = timed("keyword_search") {
            lexicalClient.search(query, prepared.lexicalReferences, SupportProgramRankingFacade.MAX_CANDIDATES)
        }
        val semanticIds = timed("semantic_search") {
            val payload = client.search(
                AiSupportProgramIndexSearchRequest(
                    query,
                    prepared.references,
                    SupportProgramRankingFacade.MAX_CANDIDATES,
                ),
            )
            fun invalid(): Nothing = throw AiServiceCallException.invalidResponse(
                "AI Service semantic search violated the internal contract", null,
            )
            if (payload.query != query) invalid()
            val matches = payload.matches ?: invalid()
            if (matches.size != minOf(SupportProgramRankingFacade.MAX_CANDIDATES, eligiblePrograms.size)) invalid()
            val seen = HashSet<String>()
            var previousScore = Double.POSITIVE_INFINITY
            matches.map { nullableMatch ->
                val match = nullableMatch ?: invalid()
                val id = match.id ?: invalid()
                if (id !in programsById) invalid()
                if (!seen.add(id) || match.contentHash != prepared.hashesById[id]) invalid()
                val score = match.score?.takeIf { it.isFinite() } ?: invalid()
                if (score > previousScore) invalid()
                previousScore = score
                id
            }
        }
        val candidateIds = combineRanks(semanticIds, keywordIds)
        return java.util.List.copyOf(candidateIds.map(programsById::getValue))
    }

    private fun prepare(programs: List<CatalogSupportProgram>): PreparedCatalog {
        // 전체 값과 순서를 비교하므로 색인 필드, 정렬 값, 접수 상태, 분류의 변경을 빠뜨리지 않습니다.
        preparedCatalog?.takeIf { it.programs == programs }?.let {
            logger.info("support_program_search preparation_cache=hit document_count={}", programs.size)
            return it
        }
        val snapshot = java.util.List.copyOf(programs.map { candidate ->
            candidate.copy(
                program = candidate.program.run {
                    copy(
                        categories = java.util.List.copyOf(categories),
                        regions = java.util.List.copyOf(regions),
                        matchedReasons = java.util.List.copyOf(matchedReasons),
                        eligibilityReview = eligibilityReview?.let { review ->
                            review.copy(
                                target = review.target.copy(evidence = java.util.List.copyOf(review.target.evidence)),
                                region = review.region.copy(evidence = java.util.List.copyOf(review.region.evidence)),
                            )
                        },
                    )
                },
                startupDetails = candidate.startupDetails?.let { details ->
                    details.copy(
                        startupStages = java.util.List.copyOf(details.startupStages),
                        applicantTypes = java.util.List.copyOf(details.applicantTypes),
                        founderAges = java.util.List.copyOf(details.founderAges),
                    )
                },
            )
        })
        val documents = snapshot.map(SupportProgramIndexDocumentMapper::fromCatalog)
        val programsById = snapshot.associateBy { it.program.sourceQualifiedId }
        check(programsById.size == snapshot.size) { "duplicate catalog identities" }
        val prepared = PreparedCatalog(
            programs = snapshot,
            programsById = java.util.Map.copyOf(programsById),
            references = java.util.List.copyOf(documents.map { it.reference() }),
            hashesById = java.util.Map.copyOf(documents.associate { it.id to it.contentHash }),
            lexicalReferences = java.util.List.copyOf(snapshot.map {
                ElasticsearchSupportProgramDocumentMapper.fromCatalog(it).reference()
            }),
        )
        // 원문 크기는 잘린 검색 문서와 별도로 제한합니다. 큰 카탈로그도 정상 검색하되 보관하지 않습니다.
        val cacheable = snapshot.sumOf(::retainedTextLength) <= MAX_CACHED_SOURCE_CHARACTERS
        preparedCatalog = prepared.takeIf { cacheable }
        logger.info(
            "support_program_search preparation_cache={} document_count={}",
            if (cacheable) "miss" else "bypass", programs.size,
        )
        return prepared
    }

    private fun retainedTextLength(candidate: CatalogSupportProgram): Long = candidate.program.run {
        val fields = listOf(
            id, sourceCode, title, organization, summary, targetDescription, applicationPeriod, sourceName, sourceUrl,
            candidate.sortTimestamp,
        ) + categories + regions + matchedReasons + candidate.startupDetails?.let {
            it.startupStages + it.applicantTypes + it.founderAges
        }.orEmpty() + eligibilityReview?.let {
            listOf(it.target.explanation, it.region.explanation) +
                it.target.evidence.map { evidence -> evidence.quote } + it.region.evidence.map { evidence -> evidence.quote }
        }.orEmpty()
        fields.sumOf { it.length.toLong() }
    }

    private data class PreparedCatalog(
        val programs: List<CatalogSupportProgram>,
        val programsById: Map<String, CatalogSupportProgram>,
        val references: List<AiSupportProgramIndexReferenceRequest>,
        val hashesById: Map<String, String>,
        val lexicalReferences: List<ElasticsearchSupportProgramReferenceRequest>,
    )

    private inline fun <T> timed(stage: String, action: () -> T): T {
        val started = System.nanoTime()
        var completed = false
        try {
            return action().also { completed = true }
        } finally {
            logger.info(
                "support_program_search stage={} outcome={} duration_ms={}",
                stage, if (completed) "success" else "failure", (System.nanoTime() - started) / 1_000_000.0,
            )
        }
    }

    private fun combineRanks(semanticIds: List<String>, keywordIds: List<String>): List<String> {
        val semanticRanks = semanticIds.withIndex().associate { it.value to it.index + 1 }
        val scores = mutableMapOf<String, Double>()
        for (ids in listOf(semanticIds, keywordIds)) {
            ids.forEachIndexed { index, id ->
                scores[id] = scores.getOrDefault(id, 0.0) + 1.0 / (RRF_OFFSET + index + 1)
            }
        }
        return scores.keys.sortedWith(
            compareByDescending<String> { scores.getValue(it) }
                .thenBy { semanticRanks[it] ?: Int.MAX_VALUE }
                .thenBy { it },
        ).take(SupportProgramRankingFacade.MAX_CANDIDATES)
    }

    private companion object {
        const val RRF_OFFSET = 60.0
        const val MAX_CACHED_SOURCE_CHARACTERS = 2_000_000L
        val logger = LoggerFactory.getLogger(AiSupportProgramRetrievalFacade::class.java)
    }
}
