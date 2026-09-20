package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core.supportprogram.client.elasticsearch.ElasticsearchSupportProgramClient
import ai.govbiz.core.supportprogram.client.elasticsearch.mapper.ElasticsearchSupportProgramDocumentMapper
import ai.govbiz.core.supportprogram.client.elasticsearch.exception.ElasticsearchClientException
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramIndexClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexMatchPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexSearchPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexSearchRequest
import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStartupDetails
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import java.text.Normalizer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.any
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class AiSupportProgramRetrievalFacadeTest {
    @Mock
    private lateinit var client: AiSupportProgramIndexClient
    @Mock
    private lateinit var lexicalClient: ElasticsearchSupportProgramClient
    private val programs = (1..25).map { catalogProgram("program-$it") }
    private val documents = programs.map(SupportProgramIndexDocumentMapper::fromCatalog)
    private val request = AiSupportProgramIndexSearchRequest("서울 AI", documents.map { it.reference() }, 20)

    @Test
    fun sendsAllTwentyFiveCurrentVersionsAndKeepsSemanticOrderWhenNoKeywordsMatch() {
        val query = "unmatchedquery"
        val request = AiSupportProgramIndexSearchRequest(query, documents.map { it.reference() }, 20)
        val selectedIndexes = listOf(24, 0) + (1..18)
        val selectedMatches = selectedIndexes.mapIndexed { rank, index -> match(index, 1.0 - rank * 0.01) }
        doReturn(AiSupportProgramIndexSearchPayload(query, selectedMatches))
            .`when`(client).search(request)

        val result = AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve(query, programs)

        assertEquals(selectedIndexes.map { "program-${it + 1}" }, result.map { it.program.id })
        verify(client).search(request)
        assertThrows(UnsupportedOperationException::class.java) {
            (result as MutableList).clear()
        }
    }

    @Test
    fun restoresAnOlderKeywordCandidateOutsideSemanticTwentyWithAUniqueTwentyCandidateBudget() {
        val query = "quartz funding"
        val candidates = (1..25).map { index ->
            catalogProgram(
                "program-$index",
                summary = when (index) {
                    20 -> "quartz"
                    25 -> "quartz funding"
                    else -> "별도 공고"
                },
            ).let { if (index == 25) it.copy(sortTimestamp = "2020-01-01") else it }
        }
        stubSemantic(query, candidates, candidates.take(20))
        stubLexical(query, candidates, listOf(candidates[24], candidates[19]))

        val result = AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve(query, candidates)
        val ids = result.map { it.program.id }

        assertEquals(20, result.size)
        assertEquals(20, ids.toSet().size)
        // 두 순위에 포함된 공고가 먼저 오고, 같은 RRF 점수에서는 의미 검색 순위를 우선한다.
        assertEquals(listOf("program-20", "program-1", "program-25"), ids.take(3))
        assertTrue(result.all { it in candidates })
    }

    @Test
    fun combinesBothRankingsAndUsesSemanticRankForEqualFusionScores() {
        val first = catalogProgram("first", "quartz").copy(sortTimestamp = "2026-08-01")
        val second = catalogProgram("second", "quartz").copy(sortTimestamp = "2026-08-02")
        val candidates = listOf(first, second, catalogProgram("third", "별도 공고"))
        stubSemantic("quartz", candidates, candidates)
        stubLexical("quartz", candidates, listOf(second, first))

        val result = AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve("quartz", candidates)

        // 의미 순위 first/second와 키워드 순위 second/first의 합은 같으므로 first가 먼저다.
        assertEquals(listOf("first", "second", "third"), result.map { it.program.id })
    }

    @Test
    fun preservesValidatedBm25OrderRegardlessOfCatalogInputOrder() {
        val query = "크롬 QUARTZ funding"
        val semantic = (1..20).map { catalogProgram("semantic-$it", "별도 공고") }
        val decomposed = Normalizer.normalize("크롬", Normalizer.Form.NFD)
        val strongest = catalogProgram("strongest", "$decomposed quartz funding")
            .copy(sortTimestamp = "2020-01-01")
        val newest = catalogProgram("newest", "크롬 quartz").copy(sortTimestamp = "2026-08-22")
        val firstTie = catalogProgram("SHARED", "quartz funding")
        val secondTie = firstTie.copy(program = firstTie.program.copy(sourceCode = "OTHER"))
        val repeated = catalogProgram("repeated", "quartz quartz quartz quartz")
        val candidates = semantic + listOf(repeated, secondTie, strongest, firstTie, newest)
        val reverse = candidates.reversed()
        stubSemantic(query, candidates, semantic)
        stubSemantic(query, reverse, semantic)
        val lexical = listOf(strongest, newest, firstTie, secondTie, repeated)
        stubLexical(query, candidates, lexical)
        stubLexical(query, reverse, lexical)
        val facade = AiSupportProgramRetrievalFacade(client, lexicalClient)

        val result = facade.retrieve(query, candidates)
        val reversedResult = facade.retrieve(query, reverse)
        val lexicalIds = result.filter { it !in semantic }.map { it.program.sourceQualifiedId }

        assertEquals(result, reversedResult)
        assertEquals(
            listOf("BIZINFO:strongest", "BIZINFO:newest", "BIZINFO:SHARED", "OTHER:SHARED", "BIZINFO:repeated"),
            lexicalIds,
        )
        assertEquals(20, result.size)
    }

    @Test
    fun combinesLexicalCandidatesOutsideTheSemanticBudget() {
        val query = "QUARTZ funding quartz"
        val semantic = (1..20).map { catalogProgram("semantic-$it", "별도 공고") }
        val unrelatedText = (1..1_000).joinToString(" ") { "unrelated$it" }
        val strongest = catalogProgram("strongest", "quartz funding $unrelatedText")
            .copy(sortTimestamp = "2020-01-01")
        val repeated = catalogProgram("repeated", "quartz ".repeat(100))
        val candidates = semantic + listOf(repeated, strongest)
        stubSemantic(query, candidates, semantic)
        stubLexical(query, candidates, listOf(strongest, repeated))

        val result = AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve(query, candidates)

        assertEquals(listOf(strongest, repeated), result.filter { it !in semantic })
    }

    @Test
    fun preservesSemanticRankingWhenBm25HasNoMatches() {
        val query = "!!!🙂"
        val semantic = programs.take(20).reversed()
        stubSemantic(query, programs, semantic)

        val result = AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve(query, programs)

        assertEquals(semantic, result)
    }

    @Test
    fun propagatesSemanticFailureEvenWhenTheCatalogHasKeywordMatches() {
        doThrow(AiServiceCallException.unavailable(null)).`when`(client).search(request)

        val failure = assertThrows(AiServiceCallException::class.java) {
            AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve("서울 AI", programs)
        }

        assertEquals(AiServiceFailure.UNAVAILABLE, failure.failure)
        verify(client).search(request)
    }

    @Test
    fun returnsBothSourcesWhenTheyShareTheSameRawProgramId() {
        val bizInfo = programs.first().copy(
            program = programs.first().program.copy(id = "SHARED", sourceCode = "BIZINFO"),
        )
        val other = bizInfo.copy(
            program = bizInfo.program.copy(
                sourceCode = "OTHER",
                sourceName = "다른 제공처",
                sourceUrl = "https://other.example/program/SHARED",
            ),
        )
        val candidates = listOf(bizInfo, other)
        val documents = candidates.map(SupportProgramIndexDocumentMapper::fromCatalog)
        val request = AiSupportProgramIndexSearchRequest("서울 AI", documents.map { it.reference() }, 20)
        doReturn(
            AiSupportProgramIndexSearchPayload(
                "서울 AI",
                listOf(
                    AiSupportProgramIndexMatchPayload(documents[1].id, documents[1].contentHash, 0.9),
                    AiSupportProgramIndexMatchPayload(documents[0].id, documents[0].contentHash, 0.8),
                ),
            ),
        ).`when`(client).search(request)

        val result = AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve("서울 AI", candidates)

        assertEquals(listOf("OTHER", "BIZINFO"), result.map { it.program.sourceCode })
        assertEquals(listOf("SHARED", "SHARED"), result.map { it.program.id })
        verify(client).search(request)
    }

    @Test
    fun rejectsMissingAndIncorrectFieldsUnknownIdsHashesDuplicatesAndUnsortedScores() {
        val validMatches = (0..19).map { match(it, 1.0 - it * 0.01) }
        val valid = validMatches.first()
        fun changedFirst(value: AiSupportProgramIndexMatchPayload?) =
            AiSupportProgramIndexSearchPayload("서울 AI", listOf(value) + validMatches.drop(1))
        val invalidResponses = listOf(
            AiSupportProgramIndexSearchPayload("different query", validMatches),
            AiSupportProgramIndexSearchPayload("서울 AI", null),
            changedFirst(null),
            changedFirst(valid.copy(id = "OTHER:program-1")),
            changedFirst(valid.copy(id = null)),
            changedFirst(valid.copy(contentHash = "outdated")),
            changedFirst(validMatches[1]),
            changedFirst(valid.copy(score = null)),
            changedFirst(valid.copy(score = Double.NaN)),
            changedFirst(valid.copy(score = Double.POSITIVE_INFINITY)),
            changedFirst(valid.copy(score = Double.NEGATIVE_INFINITY)),
            changedFirst(valid.copy(score = 0.1)),
            AiSupportProgramIndexSearchPayload("서울 AI", validMatches.dropLast(1)),
            AiSupportProgramIndexSearchPayload("서울 AI", (0..20).map { match(it, 0.5) }),
        )
        for (payload in invalidResponses) {
            doReturn(payload).`when`(client).search(request)
            val failure = assertThrows(AiServiceCallException::class.java) {
                AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve("서울 AI", programs)
            }
            assertEquals(AiServiceFailure.INVALID_RESPONSE, failure.failure, payload.toString())
        }
    }

    @Test
    fun rejectsEmptySuccessResponseForAnEligibleCatalog() {
        doReturn(AiSupportProgramIndexSearchPayload("서울 AI", emptyList())).`when`(client).search(request)
        val failure = assertThrows(AiServiceCallException::class.java) {
            AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve("서울 AI", programs)
        }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, failure.failure)
        verify(client).search(request)
    }

    @Test
    fun doesNotCallTheClientForAnEmptyCatalog() {
        assertEquals(emptyList<Any>(), AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve("서울 AI", emptyList()))
        verifyNoInteractions(client)
    }

    @Test
    fun refusesOversizedCatalogInsteadOfSilentlyTruncating() {
        val oversized = List(20_001) { programs.first() }
        val exception = assertThrows(AiServiceCallException::class.java) {
            AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve("서울 AI", oversized)
        }
        assertEquals(AiServiceFailure.UNAVAILABLE, exception.failure)
        verifyNoInteractions(client)
    }

    @Test
    fun reusesPreparedReferencesForEqualCatalogValuesButStillChecksTheIndexForEveryQuery() {
        val captured = recordSemanticRequests()
        val facade = AiSupportProgramRetrievalFacade(client, lexicalClient)
        val candidates = programs.take(3)

        assertEquals(candidates, facade.retrieve("no-match-one", candidates))
        assertEquals(candidates, facade.retrieve("no-match-two", candidates.map { it.copy(program = it.program.copy()) }))

        assertEquals(listOf("no-match-one", "no-match-two"), captured.map { it.query })
        assertSame(captured.first().eligibleDocuments, captured.last().eligibleDocuments)
        assertThrows(UnsupportedOperationException::class.java) {
            (captured.last().eligibleDocuments as MutableList).clear()
        }
    }

    @Test
    fun refreshesChangedTextClassificationStatusSortAndPublicMetadataWithoutServingStalePrograms() {
        val captured = recordSemanticRequests()
        val facade = AiSupportProgramRetrievalFacade(client, lexicalClient)
        val initial = catalogProgram("one").let {
            it.copy(program = it.program.copy(sourceCode = "KSTARTUP"))
        }
        val variants = listOf(
            initial,
            initial.copy(program = initial.program.copy(title = "변경 제목")),
            initial.copy(program = initial.program.copy(organization = "변경 기관")),
            initial.copy(program = initial.program.copy(summary = "변경 내용")),
            initial.copy(program = initial.program.copy(targetDescription = "변경 대상")),
            initial.copy(program = initial.program.copy(categories = listOf("다른 분야"))),
            initial.copy(program = initial.program.copy(regions = listOf("대구"))),
            initial.copy(program = initial.program.copy(applicationPeriod = "변경 신청 기간")),
            initial.copy(startupDetails = SupportProgramStartupDetails(listOf("예비창업"), listOf("개인"), listOf("청년"))),
            initial.copy(program = initial.program.copy(status = SupportProgramStatus.CLOSED)),
            initial.copy(sortTimestamp = "2026-09-20"),
            initial.copy(program = initial.program.copy(sourceUrl = "https://changed.example/one")),
            initial.copy(program = initial.program.copy(matchedReasons = listOf("변경 안내"))),
        )

        for (candidate in variants) {
            assertEquals(listOf(candidate), facade.retrieve("unmatched", listOf(candidate)))
            assertEquals(
                listOf(SupportProgramIndexDocumentMapper.fromCatalog(candidate).reference()),
                captured.last().eligibleDocuments,
            )
        }
        captured.zipWithNext().forEach { (before, after) ->
            assertNotSame(before.eligibleDocuments, after.eligibleDocuments)
        }
    }

    @Test
    fun isolatesMutableCallerCollectionsAndDetectsInPlaceChanges() {
        val captured = recordSemanticRequests()
        val facade = AiSupportProgramRetrievalFacade(client, lexicalClient)
        val regions = mutableListOf("서울")
        val categories = mutableListOf("AI")
        val stages = mutableListOf("예비창업")
        val candidate = catalogProgram("one").let {
            it.copy(
                program = it.program.copy(sourceCode = "KSTARTUP", regions = regions, categories = categories),
                startupDetails = SupportProgramStartupDetails(stages, emptyList(), emptyList()),
            )
        }
        val callerList = mutableListOf(candidate)
        val first = facade.retrieve("unmatched", callerList)
        regions[0] = "대구"
        categories.add("무역")
        stages[0] = "창업 3년"
        val second = facade.retrieve("unmatched", callerList)
        callerList.clear()

        assertEquals(listOf("서울"), first.single().program.regions)
        assertEquals(listOf("AI"), first.single().program.categories)
        assertEquals(listOf("예비창업"), first.single().startupDetails!!.startupStages)
        assertEquals(listOf("대구"), second.single().program.regions)
        assertEquals(listOf("AI", "무역"), second.single().program.categories)
        assertEquals(listOf("창업 3년"), second.single().startupDetails!!.startupStages)
        assertNotSame(captured.first().eligibleDocuments, captured.last().eligibleDocuments)
        assertThrows(UnsupportedOperationException::class.java) {
            (second.single().program.regions as MutableList).clear()
        }
        assertThrows(UnsupportedOperationException::class.java) {
            (second.single().startupDetails!!.startupStages as MutableList).clear()
        }
    }

    @Test
    fun keepsOnlyOneCatalogSnapshotAndDoesNotRetainOversizedSourceText() {
        val captured = recordSemanticRequests()
        val facade = AiSupportProgramRetrievalFacade(client, lexicalClient)
        val first = listOf(catalogProgram("one"))
        val second = listOf(catalogProgram("two"))
        facade.retrieve("unmatched", first)
        facade.retrieve("unmatched", second)
        facade.retrieve("unmatched", first)
        assertNotSame(captured[0].eligibleDocuments, captured[2].eligibleDocuments)

        // 검색용 문서가 12,000자로 잘려도 캐시 원문 크기 상한은 전체 원문에 적용됩니다.
        val oversized = listOf(catalogProgram("large", summary = "가".repeat(2_000_001)))
        assertEquals(oversized, facade.retrieve("unmatched", oversized))
        assertEquals(oversized, facade.retrieve("unmatched", oversized))
        assertNotSame(captured[3].eligibleDocuments, captured[4].eligibleDocuments)
    }

    @Test
    fun searchesIndependentSnapshotsConcurrentlyWithoutHoldingALockAcrossTheClientCall() {
        val firstInsideClient = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        doAnswer { invocation ->
            val request = invocation.getArgument<AiSupportProgramIndexSearchRequest>(0)
            if (request.query == "first") {
                firstInsideClient.countDown()
                check(releaseFirst.await(10, TimeUnit.SECONDS))
            }
            semanticResponse(request)
        }.`when`(client).search(any(AiSupportProgramIndexSearchRequest::class.java) ?: request)
        val facade = AiSupportProgramRetrievalFacade(client, lexicalClient)
        val first = listOf(catalogProgram("one", summary = "첫 번째 버전"))
        val second = listOf(catalogProgram("one", summary = "변경된 버전"))
        val executor = Executors.newFixedThreadPool(2)
        try {
            val pendingFirst = executor.submit<List<CatalogSupportProgram>> { facade.retrieve("first", first) }
            assertTrue(firstInsideClient.await(5, TimeUnit.SECONDS))
            val completedSecond = executor.submit<List<CatalogSupportProgram>> { facade.retrieve("second", second) }
            assertEquals(second, completedSecond.get(5, TimeUnit.SECONDS))
            releaseFirst.countDown()
            assertEquals(first, pendingFirst.get(5, TimeUnit.SECONDS))
            assertEquals(second, facade.retrieve("second", second))
        } finally {
            releaseFirst.countDown()
            executor.shutdownNow()
        }
    }

    private fun recordSemanticRequests(): MutableList<AiSupportProgramIndexSearchRequest> {
        val captured = mutableListOf<AiSupportProgramIndexSearchRequest>()
        doAnswer { invocation ->
            val request = invocation.getArgument<AiSupportProgramIndexSearchRequest>(0)
            captured += request
            semanticResponse(request)
        }.`when`(client).search(any(AiSupportProgramIndexSearchRequest::class.java) ?: request)
        return captured
    }

    @Test
    fun lexicalFailureStopsBeforeSemanticSearchOrPaidEmbedding() {
        val references = programs.map { ElasticsearchSupportProgramDocumentMapper.fromCatalog(it).reference() }
        doThrow(ElasticsearchClientException("unavailable")).`when`(lexicalClient).search("서울 AI", references, 20)
        assertThrows(ElasticsearchClientException::class.java) {
            AiSupportProgramRetrievalFacade(client, lexicalClient).retrieve("서울 AI", programs)
        }
        verifyNoInteractions(client)
    }

    private fun stubLexical(query: String, candidates: List<CatalogSupportProgram>, selected: List<CatalogSupportProgram>) {
        doReturn(selected.map { it.program.sourceQualifiedId }).`when`(lexicalClient).search(
            query, candidates.map { ElasticsearchSupportProgramDocumentMapper.fromCatalog(it).reference() }, 20,
        )
    }

    private fun semanticResponse(request: AiSupportProgramIndexSearchRequest) = AiSupportProgramIndexSearchPayload(
        request.query,
        request.eligibleDocuments.take(20).mapIndexed { index, document ->
            AiSupportProgramIndexMatchPayload(document.id, document.contentHash, 1.0 - index * 0.01)
        },
    )

    private fun match(index: Int, score: Double) = AiSupportProgramIndexMatchPayload(
        documents[index].id, documents[index].contentHash, score,
    )

    private fun stubSemantic(
        query: String,
        candidates: List<CatalogSupportProgram>,
        selected: List<CatalogSupportProgram>,
    ) {
        val documents = candidates.map(SupportProgramIndexDocumentMapper::fromCatalog)
        val request = AiSupportProgramIndexSearchRequest(query, documents.map { it.reference() }, 20)
        val matches = selected.mapIndexed { index, candidate ->
            val document = SupportProgramIndexDocumentMapper.fromCatalog(candidate)
            AiSupportProgramIndexMatchPayload(document.id, document.contentHash, 1.0 - index * 0.01)
        }
        doReturn(AiSupportProgramIndexSearchPayload(query, matches)).`when`(client).search(request)
    }
}
