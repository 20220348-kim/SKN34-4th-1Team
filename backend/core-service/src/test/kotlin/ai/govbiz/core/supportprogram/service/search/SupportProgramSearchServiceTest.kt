package ai.govbiz.core.supportprogram.service.search

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.SupportProgramRankingFacade
import ai.govbiz.core.supportprogram.facade.AiSupportProgramRetrievalFacade
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import java.time.LocalDate
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito
import org.mockito.junit.jupiter.MockitoExtension
import org.slf4j.LoggerFactory

@ExtendWith(MockitoExtension::class)
class SupportProgramSearchServiceTest {

    @Mock
    private lateinit var supportProgramRepository: SupportProgramRepository

    @Mock
    private lateinit var retrieval: AiSupportProgramRetrievalFacade

    private lateinit var ranking: RecordingSupportProgramRankingFacade

    @BeforeEach
    fun setUp() {
        ranking = RecordingSupportProgramRankingFacade()
    }

    @Test
    fun returnsCatalogProgramsWithoutRankingForABlankLatestProgramsRequest() {
        Mockito.doReturn(
            listOf(
                catalogProgram(
                    id = "open",
                    summary = "AI 기술 지원",
                    applicationPeriod = "2026-08-20 ~ 2026-09-11",
                    applicationStartDate = LocalDate.of(2026, 8, 20),
                    applicationEndDate = LocalDate.of(2026, 9, 11),
                ),
                catalogProgram(id = "rolling", applicationPeriod = "상시 접수"),
                catalogProgram(id = "upcoming", status = SupportProgramStatus.UPCOMING),
                catalogProgram(id = "unknown", status = SupportProgramStatus.UNKNOWN),
                catalogProgram(id = "closed", status = SupportProgramStatus.CLOSED),
            ),
        ).`when`(supportProgramRepository).findPublishedPresent()

        val result = service().search("", false)
        val byId = result.programs.associateBy(SupportProgram::id)

        assertEquals(SupportProgramStatus.OPEN, byId.getValue("open").status)
        assertEquals("AI 기술 지원", byId.getValue("open").summary)
        assertEquals("2026-08-20", byId.getValue("open").applicationStartDate.toString())
        assertEquals("2026-09-11", byId.getValue("open").applicationEndDate.toString())
        assertEquals(SupportProgramStatus.OPEN, byId.getValue("rolling").status)
        assertNull(byId.getValue("rolling").applicationEndDate)
        assertEquals(SupportProgramStatus.UPCOMING, byId.getValue("upcoming").status)
        assertEquals(SupportProgramStatus.UNKNOWN, byId.getValue("unknown").status)
        assertEquals(SupportProgramStatus.CLOSED, byId.getValue("closed").status)
        assertNull(byId.getValue("open").recommendationScore)
        assertEquals(emptyList<String>(), byId.getValue("open").matchedReasons)
        assertEquals(emptyList<RankingCall>(), ranking.calls)
        Mockito.verifyNoInteractions(retrieval)
        Mockito.verify(supportProgramRepository).findPublishedPresent()
        Mockito.verify(supportProgramRepository, Mockito.never()).findSearchablePresent()
    }

    @Test
    fun sendsFilteredCatalogCandidatesToLlmRankingAndReturnsItsResult() {
        val query = "서울에서 AI 창업기업이 받을 지원사업"
        val open = catalogProgram(id = "open", summary = "AI 창업 지원")
        Mockito.doReturn(listOf(open)).`when`(retrieval).retrieve(query, listOf(open))
        Mockito.doReturn(
            listOf(
                open,
                catalogProgram(
                    id = "closed",
                    summary = "지난 AI 지원",
                    status = SupportProgramStatus.CLOSED,
                ),
            ),
        ).`when`(supportProgramRepository).findSearchablePresent()
        ranking.response = { candidates ->
            listOf(
                candidates.single().program.copy(
                    recommendationScore = 93,
                    matchedReasons = listOf("서울 AI 창업기업 대상"),
                ),
            )
        }

        val result = service().search(query, true)

        val rankedCandidates = ranking.calls.single().candidates
        assertEquals(listOf("open"), rankedCandidates.map { it.program.id })
        assertEquals(93, result.programs.single().recommendationScore)
        assertEquals(listOf("서울 AI 창업기업 대상"), result.programs.single().matchedReasons)
    }

    @Test
    fun returnsAnEmptyResultWhenNoRankedCandidateMeetsTheRecommendationMinimum() {
        val query = "서울 AI 창업기업이 받을 지원사업"
        val open = catalogProgram(id = "open", summary = "AI 창업 지원")
        Mockito.doReturn(listOf(open)).`when`(retrieval).retrieve(query, listOf(open))
        Mockito.doReturn(listOf(open)).`when`(supportProgramRepository).findSearchablePresent()
        ranking.response = { emptyList() }

        val result = service().search(query, true)

        assertEquals(emptyList<SupportProgram>(), result.programs)
        assertEquals(1, ranking.calls.size)
    }

    @Test
    fun searchesAllCurrentProgramsAndCanRankAnOlderProgramBeyondThePreviousTwentyNewest() {
        val programs = (1..25).map { index ->
                catalogProgram(
                    id = "program-$index",
                    title = if (index == 1) "서울 AI 기술 지원" else "수출 공고 $index",
                    sortTimestamp = "2026-08-${index.toString().padStart(2, '0')} 10:00:00",
                )
            }
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(listOf(programs.first())).`when`(retrieval).retrieve("서울 AI", programs)
        ranking.response = { it.map { candidate -> candidate.program } }

        val result = service().search("서울 AI", false)

        val rankedCandidates = ranking.calls.single().candidates
        assertEquals(listOf("program-1"), rankedCandidates.map { it.program.id })
        assertEquals("program-1", result.programs.single().id)
        Mockito.verify(retrieval).retrieve("서울 AI", programs)
    }

    @Test
    fun changingTheQueryChangesTheSemanticCandidatesBeforeRanking() {
        val programs = listOf(catalogProgram("ai"), catalogProgram("export"))
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(listOf(programs.first())).`when`(retrieval).retrieve("AI", programs)
        Mockito.doReturn(listOf(programs.last())).`when`(retrieval).retrieve("수출", programs)
        ranking.response = { it.map { candidate -> candidate.program } }

        assertEquals("ai", service().search("AI", false).programs.single().id)
        assertEquals("export", service().search("수출", false).programs.single().id)
    }

    @Test
    fun filtersClosedAndUpcomingBeforeSemanticCandidateSelection() {
        val open = catalogProgram("old-open", sortTimestamp = "2020-01-01")
        val programs = (1..25).map { catalogProgram("closed-$it", status = SupportProgramStatus.CLOSED) } +
            catalogProgram("upcoming", status = SupportProgramStatus.UPCOMING) + open
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(listOf(open)).`when`(retrieval).retrieve("AI", listOf(open))
        ranking.response = { it.map { candidate -> candidate.program } }

        assertEquals("old-open", service().search("AI", true).programs.single().id)
        Mockito.verify(retrieval).retrieve("AI", listOf(open))
    }

    @Test
    fun propagatesIndexNotReadyInsteadOfFallingBackToNewestPrograms() {
        val programs = listOf(catalogProgram("open"))
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doThrow(ai.govbiz.core._common.exception.AiServiceCallException.unavailable(null))
            .`when`(retrieval).retrieve("AI", programs)

        assertThrows(ai.govbiz.core._common.exception.AiServiceCallException::class.java) {
            service().search("AI", true)
        }
        assertEquals(emptyList<RankingCall>(), ranking.calls)
    }

    @Test
    fun usesSourceQualifiedIdentityAsATieBreakerForProgramsWithTheSameSortTimestamp() {
        val other = catalogProgram(id = "SHARED", sourceCode = "OTHER")
        val bizInfo = catalogProgram(id = "SHARED", sourceCode = "BIZINFO")
        Mockito.doReturn(
            listOf(other, bizInfo),
        ).`when`(supportProgramRepository).findPublishedPresent()

        val result = service().search("", false)

        assertEquals(listOf("BIZINFO", "OTHER"), result.programs.map(SupportProgram::sourceCode))
        assertEquals(listOf("SHARED", "SHARED"), result.programs.map(SupportProgram::id))
    }

    @Test
    fun returnsAnImmutableResultList() {
        Mockito.doReturn(listOf(catalogProgram(id = "open")))
            .`when`(supportProgramRepository).findPublishedPresent()

        val result = service().search("   ", true)

        assertThrows(UnsupportedOperationException::class.java) {
            (result.programs as MutableList<SupportProgram>).add(result.programs.single())
        }
    }

    @Test
    fun capturesCanonicalSemanticCandidatesAndFinalProgramsForEvaluation() {
        val query = "서울 AI 창업 지원"
        val open = catalogProgram(id = "PBLN_OPEN", summary = "서울 AI 창업 지원")
        val closed = catalogProgram(id = "PBLN_CLOSED", status = SupportProgramStatus.CLOSED)
        Mockito.doReturn(listOf(open, closed)).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(listOf(open)).`when`(retrieval).retrieve(query, listOf(open))
        ranking.response = { candidates ->
            listOf(candidates.single().program.copy(recommendationScore = 91, matchedReasons = listOf("서울 AI 대상")))
        }

        val trace = service().searchWithTrace(query, acceptingOnly = true)

        assertEquals(query, trace.result.query)
        assertEquals(listOf("BIZINFO:PBLN_OPEN"), trace.candidateIds)
        assertEquals(listOf("BIZINFO:PBLN_OPEN"), trace.finalProgramIds)
        assertEquals(2, trace.presentProgramCount)
        assertEquals(1, trace.eligibleProgramCount)
        assertTrue(trace.eligibleCatalogFingerprint.matches(Regex("[0-9a-f]{64}")))
    }

    @Test
    fun usesTheEvaluationReferenceDateForTraceEligibility() {
        val openOnReferenceDate = catalogProgram(
            id = "PBLN_OPEN_ON_REFERENCE_DATE",
            status = SupportProgramStatus.CLOSED,
            applicationPeriod = "2026-09-01 ~ 2026-09-06",
            applicationStartDate = LocalDate.of(2026, 9, 1),
            applicationEndDate = LocalDate.of(2026, 9, 6),
        )
        val closedOnReferenceDate = catalogProgram(
            id = "PBLN_CLOSED_ON_REFERENCE_DATE",
            status = SupportProgramStatus.OPEN,
            applicationPeriod = "2026-08-01 ~ 2026-09-04",
            applicationStartDate = LocalDate.of(2026, 8, 1),
            applicationEndDate = LocalDate.of(2026, 9, 4),
        )
        val expectedOpenOnReferenceDate = openOnReferenceDate.copy(
            program = openOnReferenceDate.program.copy(status = SupportProgramStatus.OPEN),
        )
        Mockito.doReturn(listOf(openOnReferenceDate, closedOnReferenceDate))
            .`when`(supportProgramRepository)
            .findSearchablePresent()
        Mockito.doReturn(listOf(expectedOpenOnReferenceDate))
            .`when`(retrieval)
            .retrieve("서울 AI", listOf(expectedOpenOnReferenceDate))
        ranking.response = { candidates ->
            candidates.map { candidate -> candidate.program.copy(recommendationScore = 90) }
        }

        val trace = service().searchWithTrace(
            rawQuery = "서울 AI",
            acceptingOnly = true,
            referenceDate = LocalDate.of(2026, 9, 5),
        )

        assertEquals(listOf("BIZINFO:PBLN_OPEN_ON_REFERENCE_DATE"), trace.candidateIds)
        assertEquals(SupportProgramStatus.OPEN, trace.result.programs.single().status)
        assertEquals(1, trace.eligibleProgramCount)
    }

    @Test
    fun keepsSameRawIdsFromDifferentSourcesDistinctInSearchTrace() {
        val query = "서울 AI 지원"
        val bizInfo = catalogProgram(id = "SHARED", sourceCode = "BIZINFO")
        val other = catalogProgram(id = "SHARED", sourceCode = "OTHER")
        val candidates = listOf(other, bizInfo)
        Mockito.doReturn(candidates).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(candidates).`when`(retrieval).retrieve(query, candidates)
        ranking.response = { selected ->
            selected.map { candidate ->
                candidate.program.copy(recommendationScore = 90, matchedReasons = listOf("서울 AI 관련"))
            }
        }

        val trace = service().searchWithTrace(query, acceptingOnly = true)

        assertEquals(listOf("OTHER:SHARED", "BIZINFO:SHARED"), trace.candidateIds)
        assertEquals(listOf("OTHER:SHARED", "BIZINFO:SHARED"), trace.finalProgramIds)
        assertEquals(listOf("OTHER", "BIZINFO"), trace.result.programs.map(SupportProgram::sourceCode))
    }

    @Test
    fun appliesCompanyConditionsToRetrievalAndRankingWithoutFilteringUnknownRegions() {
        val query = "사업화 지원"
        val conditions = SupportProgramCompanyConditions("부산", "제조업", LocalDate.of(2024, 2, 29), "시제품 제작")
        val unknownRegion = catalogProgram("unknown-region").let { it.copy(program = it.program.copy(regions = emptyList())) }
        val programs = listOf(unknownRegion, catalogProgram("seoul"))
        val retrievalQuery = "$query\n부산\n제조업\n시제품 제작"
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(programs).`when`(retrieval).retrieve(retrievalQuery, programs)

        val result = service().search("  $query  ", true, conditions)

        assertEquals(query, result.query)
        assertEquals(RankingCall(query, programs, 5, conditions, LocalDate.of(2026, 9, 7)), ranking.calls.single())
        Mockito.verify(retrieval).retrieve(retrievalQuery, programs)
    }

    @Test
    fun keepsMaximumLengthQueryUnchangedForRankingWhileBoundingEnrichedRetrieval() {
        val query = "가".repeat(500)
        val conditions = SupportProgramCompanyConditions("나".repeat(50), "다".repeat(100), LocalDate.of(1900, 1, 1), "라".repeat(100))
        val programs = listOf(catalogProgram("open"))
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doAnswer { invocation ->
            val enriched = invocation.getArgument<String>(0)
            assertTrue(enriched.length <= 1000)
            assertTrue(enriched.startsWith(query))
            assertTrue(enriched.contains(conditions.region!!))
            assertTrue(enriched.contains(conditions.industry!!))
            assertTrue(enriched.contains(conditions.supportPurpose!!))
            assertFalse(enriched.contains("1900-01-01"))
            programs
        }.`when`(retrieval).retrieve(Mockito.anyString(), Mockito.anyList())

        assertEquals(query, service().search(query, false, conditions).query)
        assertEquals(query, ranking.calls.single().query)
        assertEquals(conditions, ranking.calls.single().companyConditions)
    }

    @Test
    fun keepsUserRequestedDatesButDoesNotAddSystemDatesToRetrieval() {
        val query = "2026-10-15까지 신청 가능한 지원"
        val conditions = SupportProgramCompanyConditions(
            region = "대전",
            industry = "인공지능",
            establishedOn = LocalDate.of(2024, 2, 29),
        )
        val programs = listOf(catalogProgram("open"))
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doAnswer { invocation ->
            assertEquals("$query\n대전\n인공지능", invocation.getArgument<String>(0))
            programs
        }.`when`(retrieval).retrieve(Mockito.anyString(), Mockito.anyList())

        service().search(query, true, conditions)

        assertEquals(conditions, ranking.calls.single().companyConditions)
        assertEquals(LocalDate.of(2026, 9, 7), ranking.calls.single().referenceDate)
    }

    @Test
    fun keepsRetrievalQueryUnchangedWhenOnlyEstablishmentDateIsProvided() {
        val query = "사업화 지원"
        val conditions = SupportProgramCompanyConditions(establishedOn = LocalDate.of(2024, 2, 29))
        val programs = listOf(catalogProgram("open"))
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doAnswer { invocation ->
            assertEquals(query, invocation.getArgument<String>(0))
            programs
        }.`when`(retrieval).retrieve(Mockito.anyString(), Mockito.anyList())

        service().search(query, true, conditions)

        assertEquals(conditions, ranking.calls.single().companyConditions)
        assertEquals(LocalDate.of(2026, 9, 7), ranking.calls.single().referenceDate)
    }

    @Test
    fun capturesTheSameConditionAwareSearchPathAsThePublicSearch() {
        val query = "사업화 지원"
        val conditions = SupportProgramCompanyConditions(
            region = "부산",
            establishedOn = LocalDate.of(2024, 2, 29),
            supportPurpose = "시제품 제작",
        )
        val programs = listOf(catalogProgram("open"))
        val retrievalQuery = "$query\n부산\n시제품 제작"
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(programs).`when`(retrieval).retrieve(retrievalQuery, programs)
        ranking.response = { it.map(CatalogSupportProgram::program) }
        val service = service()

        val publicResult = service.search(query, true, conditions)
        val trace = service.searchWithTrace(query, true, companyConditions = conditions)

        assertEquals(publicResult, trace.result)
        assertEquals(listOf("BIZINFO:open"), trace.candidateIds)
        assertEquals(listOf("BIZINFO:open"), trace.finalProgramIds)
        assertEquals(1, trace.presentProgramCount)
        assertEquals(1, trace.eligibleProgramCount)
        assertEquals(ranking.calls.first(), ranking.calls.last())
        assertEquals(conditions, ranking.calls.last().companyConditions)
        assertEquals(LocalDate.of(2026, 9, 7), ranking.calls.last().referenceDate)
        Mockito.verify(retrieval, Mockito.times(2)).retrieve(retrievalQuery, programs)
    }

    @Test
    fun usesTheFixedEvaluationDateForConditionReviewWithoutPuttingDatesIntoRetrieval() {
        val query = "시제품 제작"
        val referenceDate = LocalDate.of(2026, 9, 5)
        val conditions = SupportProgramCompanyConditions(
            region = "부산",
            establishedOn = LocalDate.of(2024, 2, 29),
        )
        val closedToday = catalogProgram(
            id = "open-at-evaluation",
            status = SupportProgramStatus.CLOSED,
            applicationPeriod = "2026-09-01 ~ 2026-09-06",
            applicationStartDate = LocalDate.of(2026, 9, 1),
            applicationEndDate = LocalDate.of(2026, 9, 6),
        )
        val openAtEvaluation = closedToday.copy(program = closedToday.program.copy(status = SupportProgramStatus.OPEN))
        Mockito.doReturn(listOf(closedToday)).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(listOf(openAtEvaluation)).`when`(retrieval).retrieve("$query\n부산", listOf(openAtEvaluation))
        ranking.response = { it.map(CatalogSupportProgram::program) }

        val trace = service().searchWithTrace(query, true, referenceDate, conditions)

        assertEquals(listOf("BIZINFO:open-at-evaluation"), trace.candidateIds)
        assertEquals(listOf("BIZINFO:open-at-evaluation"), trace.finalProgramIds)
        assertEquals(1, trace.eligibleProgramCount)
        assertEquals(SupportProgramStatus.OPEN, trace.result.programs.single().status)
        assertEquals(conditions, ranking.calls.single().companyConditions)
        assertEquals(referenceDate, ranking.calls.single().referenceDate)
        Mockito.verify(retrieval).retrieve("$query\n부산", listOf(openAtEvaluation))
    }

    @Test
    fun changingAndClearingConditionsDoesNotLeakThePreviousRequest() {
        val programs = listOf(catalogProgram("open"))
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(programs).`when`(retrieval).retrieve(Mockito.anyString(), Mockito.anyList())
        val service = service()
        val seoul = SupportProgramCompanyConditions(region = "서울")
        val busan = SupportProgramCompanyConditions(region = "부산")

        service.search("사업화", false, seoul)
        service.search("사업화", false, busan)
        service.search("사업화", false)

        assertEquals(listOf(seoul, busan, null), ranking.calls.map { it.companyConditions })
        assertNull(ranking.calls.last().referenceDate)
        Mockito.verify(retrieval).retrieve("사업화", programs)
    }

    @Test
    fun recordsDatabasePreparationRetrievalRankingAndTotalTimingWithoutUserOrProgramText() {
        val query = "사용자 비공개 질문"
        val conditions = SupportProgramCompanyConditions(region = "비공개 소재지")
        val programs = listOf(catalogProgram("private", summary = "비공개 본문"))
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(programs).`when`(retrieval).retrieve("$query\n${conditions.region}", programs)
        ranking.response = { it.map(CatalogSupportProgram::program) }

        val messages = timingLogs { service().search(query, false, conditions) }

        assertEquals(5, messages.size)
        for (stage in listOf("database_fetch", "eligibility_prepare", "retrieval", "ranking", "total")) {
            assertTrue(messages.any { it.contains("stage=$stage outcome=success duration_ms=") })
        }
        assertTrue(messages.all { it.substringAfter("duration_ms=").toDouble() >= 0.0 })
        assertFalse(messages.any { it.contains("비공개") || it.contains("private") })
    }

    @Test
    fun recordsFailedRankingAndTotalTimingWithoutLoggingTheExceptionOrHidingFailure() {
        val programs = listOf(catalogProgram("private"))
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(programs).`when`(retrieval).retrieve("비공개 질문", programs)
        ranking.response = { throw IllegalStateException("비공개 오류 본문") }

        val messages = timingLogs {
            val failure = assertThrows(IllegalStateException::class.java) {
                service().search("비공개 질문", false)
            }
            assertEquals("비공개 오류 본문", failure.message)
        }

        assertTrue(messages.any { it.contains("stage=ranking outcome=failure duration_ms=") })
        assertTrue(messages.any { it.contains("stage=total outcome=failure duration_ms=") })
        assertFalse(messages.any { it.contains("비공개") || it.contains("private") })
    }

    private fun timingLogs(action: () -> Unit): List<String> {
        val logger = LoggerFactory.getLogger(SupportProgramSearchService::class.java) as Logger
        val appender = ListAppender<ILoggingEvent>().apply { start() }
        logger.addAppender(appender)
        try {
            action()
            return appender.list.map { it.formattedMessage }
        } finally {
            logger.detachAppender(appender)
            appender.stop()
        }
    }

    private fun service() = SupportProgramSearchService(
        supportProgramRepository,
        ranking,
        retrieval,
        Clock.fixed(Instant.parse("2026-09-06T15:00:00Z"), ZoneId.of("Asia/Seoul")),
    )

    private fun catalogProgram(
        id: String,
        title: String = "$id 공고",
        summary: String = "AI 지원",
        status: SupportProgramStatus = SupportProgramStatus.OPEN,
        applicationPeriod: String = "상시 접수",
        applicationStartDate: LocalDate? = null,
        applicationEndDate: LocalDate? = null,
        sourceCode: String = "BIZINFO",
        sortTimestamp: String = "2026-08-21 10:00:00",
    ) = CatalogSupportProgram(
        program = SupportProgram(
            id = id,
            sourceCode = sourceCode,
            title = title,
            organization = "수행기관",
            summary = summary,
            categories = listOf("AI"),
            regions = listOf("서울"),
            targetDescription = "중소기업",
            applicationPeriod = applicationPeriod,
            applicationStartDate = applicationStartDate,
            applicationEndDate = applicationEndDate,
            status = status,
            sourceName = if (sourceCode == "BIZINFO") "기업마당" else sourceCode,
            sourceUrl = "https://${sourceCode.lowercase()}.example/detail?id=$id",
            matchedReasons = emptyList(),
            recommendationScore = null,
        ),
        sortTimestamp = sortTimestamp,
    )

    private data class RankingCall(
        val query: String,
        val candidates: List<CatalogSupportProgram>,
        val limit: Int,
        val companyConditions: SupportProgramCompanyConditions? = null,
        val referenceDate: LocalDate? = null,
    )

    private class RecordingSupportProgramRankingFacade : SupportProgramRankingFacade {
        val calls = mutableListOf<RankingCall>()
        var response: (List<CatalogSupportProgram>) -> List<SupportProgram> = { emptyList() }

        override fun rank(
            query: String,
            candidates: List<CatalogSupportProgram>,
            limit: Int,
            companyConditions: SupportProgramCompanyConditions?,
            referenceDate: LocalDate?,
        ): List<SupportProgram> {
            calls += RankingCall(query, candidates, limit, companyConditions, referenceDate)
            return response(candidates)
        }
    }
}
