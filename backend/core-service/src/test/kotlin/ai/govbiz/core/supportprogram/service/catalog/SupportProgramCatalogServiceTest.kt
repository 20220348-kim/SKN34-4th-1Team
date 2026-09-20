package ai.govbiz.core.supportprogram.service.catalog

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCatalogSort
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityAssessment
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReview
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReviewStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramStartupDetails
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import java.time.LocalDate
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mockito

class SupportProgramCatalogServiceTest {
    private val repository = Mockito.mock(SupportProgramRepository::class.java)
    private val service = SupportProgramCatalogService(repository)

    @AfterEach
    fun onlyReadsThePublishedSnapshot() {
        Mockito.verify(repository).findPublishedPresent()
        Mockito.verifyNoMoreInteractions(repository)
    }

    @Test
    fun blankKeywordDefaultsToOpenLatestProgramsWithoutAiEligibilityOrRanking() {
        val assessment = SupportProgramEligibilityAssessment(SupportProgramEligibilityStatus.UNKNOWN, "확인 필요", emptyList())
        val ranked = candidate("latest", timestamp = "2026-09-08T10:00:00").let {
            it.copy(program = it.program.copy(
                matchedReasons = listOf("과거 추천"),
                recommendationScore = 99,
                eligibilityReview = SupportProgramEligibilityReview(SupportProgramEligibilityReviewStatus.REVIEW_REQUIRED, assessment, assessment),
            ))
        }
        snapshot(candidate("older"), candidate("closed", status = SupportProgramStatus.CLOSED), ranked)

        val result = service.browse()

        assertEquals(listOf("latest", "older"), result.programs.map { it.id })
        assertEquals(2, result.total)
        assertEquals(1, result.page)
        assertEquals(12, result.pageSize)
        assertEquals(1, result.totalPages)
        result.programs.forEach {
            assertTrue(it.matchedReasons.isEmpty())
            assertNull(it.recommendationScore)
            assertNull(it.eligibilityReview)
        }
    }

    @Test
    fun keywordMatchesTitleOrOrganizationIgnoringCaseAndTrimsOuterSpaces() {
        snapshot(
            candidate("title", title = "AI 수출 지원"),
            candidate("organization", organization = "AI 진흥원"),
            candidate("summary-only", summary = "AI 수출"),
        )

        val result = service.browse(rawKeyword = "  ai  ")

        assertEquals(setOf("title", "organization"), result.programs.map { it.id }.toSet())
    }

    @Test
    fun percentAndUnderscoreAreLiteralCharactersNotSqlWildcards() {
        snapshot(candidate("literal", title = "50%_수출 비용"), candidate("ordinary", title = "50퍼센트 수출 비용"))

        assertEquals(listOf("literal"), service.browse(rawKeyword = "%_").programs.map { it.id })
    }

    @Test
    fun regionAndCategoryUseExactProviderTagsAndCombineWithKeywordAndStatus() {
        snapshot(
            candidate("seoul", title = "수출 지원", regions = listOf("서울"), categories = listOf("수출")),
            candidate("gyeongbuk", title = "수출 지원", regions = listOf("경북"), categories = listOf("수출")),
            candidate("national", title = "수출 지원", regions = listOf("전국"), categories = listOf("수출")),
            candidate("partial", title = "수출 지원", regions = listOf("서울특별시"), categories = listOf("수출")),
            candidate("other-category", title = "수출 지원", regions = listOf("서울"), categories = listOf("기술")),
            candidate("closed", title = "수출 지원", regions = listOf("서울"), categories = listOf("수출"), status = SupportProgramStatus.CLOSED),
        )

        val result = service.browse(rawKeyword = "수출", rawRegion = " 서울 ", rawCategory = " 수출 ")

        assertEquals(listOf("seoul"), result.programs.map { it.id })
        assertEquals(listOf("경북", "서울", "서울특별시", "전국"), result.regions)
        assertEquals(listOf("기술", "수출"), result.categories)
    }

    @Test
    fun facetsComeFromTheWholeSnapshotEvenWhenUnknownFilterMatchesNothing() {
        snapshot(
            candidate("open", regions = listOf("서울", "서울", ""), categories = listOf("수출")),
            candidate("closed", regions = listOf("부산"), categories = listOf("기술", " "), status = SupportProgramStatus.CLOSED),
        )

        val result = service.browse(rawRegion = "없는 지역", page = 9, pageSize = 1)

        assertTrue(result.programs.isEmpty())
        assertEquals(0, result.total)
        assertEquals(0, result.totalPages)
        assertEquals(9, result.page)
        assertEquals(listOf("부산", "서울"), result.regions)
        assertEquals(listOf("기술", "수출"), result.categories)
    }

    @Test
    fun unknownCategoryProducesEmptyResultsInsteadOfIgnoringTheFilter() {
        snapshot(candidate("known", categories = listOf("수출")))

        assertTrue(service.browse(rawCategory = "기타 미등록 분야").programs.isEmpty())
    }

    @Test
    fun allStatusRetainsOpenUpcomingClosedAndUnknownWithoutReinterpretingDates() {
        snapshot(*SupportProgramStatus.entries.map { candidate(it.name, status = it) }.toTypedArray())

        val result = service.browse(status = null)

        assertEquals(SupportProgramStatus.entries.toSet(), result.programs.map { it.status }.toSet())
        assertEquals(4, result.total)
    }

    @Test
    fun requestedStatusIsMatchedExactly() {
        snapshot(*SupportProgramStatus.entries.map { candidate(it.name, status = it) }.toTypedArray())

        assertEquals(listOf("UNKNOWN"), service.browse(status = SupportProgramStatus.UNKNOWN).programs.map { it.id })
    }

    @Test
    fun deadlineSortPutsUnknownDatesLastAndUsesRecentOrderForTies() {
        snapshot(
            candidate("undated", endDate = null, timestamp = "2026-09-10"),
            candidate("later", endDate = LocalDate.parse("2026-10-01")),
            candidate("early-old", endDate = LocalDate.parse("2026-09-09")),
            candidate("early-new", endDate = LocalDate.parse("2026-09-09"), timestamp = "2026-09-08"),
        )

        assertEquals(listOf("early-new", "early-old", "later", "undated"), service.browse(sort = SupportProgramCatalogSort.DEADLINE).programs.map { it.id })
    }

    @Test
    fun recentSortKeepsSameOriginalIdAcrossSourcesAndMovesBlankTimestampsLast() {
        snapshot(
            candidate("same", sourceCode = "KSTARTUP", timestamp = "2026-09-08"),
            candidate("same", sourceCode = "BIZINFO", timestamp = "2026-09-08"),
            candidate("missing", timestamp = ""),
            candidate("blank", timestamp = " "),
            candidate("older", timestamp = "2026-09-07"),
        )

        assertEquals(
            listOf("BIZINFO:same", "KSTARTUP:same", "BIZINFO:older", "BIZINFO:blank", "BIZINFO:missing"),
            service.browse().programs.map { it.sourceQualifiedId },
        )
    }

    @Test
    fun paginationReturnsRequestedSliceWithWholeFilteredTotals() {
        snapshot(*List(5) { candidate("id-$it") }.toTypedArray())

        val result = service.browse(page = 3, pageSize = 2)

        assertEquals(listOf("id-4"), result.programs.map { it.id })
        assertEquals(5, result.total)
        assertEquals(3, result.page)
        assertEquals(2, result.pageSize)
        assertEquals(3, result.totalPages)
    }

    @Test
    fun outOfRangePageIsEmptyWithoutClampingOrIntegerOverflow() {
        snapshot(candidate("single"))

        val result = service.browse(page = 1_000_000, pageSize = 50)

        assertTrue(result.programs.isEmpty())
        assertEquals(1, result.total)
        assertEquals(1, result.totalPages)
        assertEquals(1_000_000, result.page)
    }

    @Test
    fun emptyPublishedSnapshotReturnsARealEmptyCatalog() {
        snapshot()

        val result = service.browse()

        assertTrue(result.programs.isEmpty())
        assertTrue(result.regions.isEmpty())
        assertTrue(result.categories.isEmpty())
        assertEquals(0, result.totalPages)
    }

    @Test
    fun repositoryFailureIsNotHiddenAsAnEmptySuccessfulCatalog() {
        val error = IllegalStateException("unavailable database")
        Mockito.`when`(repository.findPublishedPresent()).thenThrow(error)

        assertSame(error, assertThrows(IllegalStateException::class.java) { service.browse() })
    }

    private fun snapshot(vararg programs: CatalogSupportProgram) {
        Mockito.`when`(repository.findPublishedPresent()).thenReturn(programs.toList())
    }

    @Test
    fun filtersSourceWithoutCollidingOriginalIdsAcrossProviders() {
        snapshot(candidate("same"), candidate("same", sourceCode = "KSTARTUP"))

        assertEquals(listOf("KSTARTUP:same"), service.browse(sourceCode = "KSTARTUP").programs.map { it.sourceQualifiedId })
    }

    @Test
    fun combinesNativeStartupTagsExactlyWithoutInferringMissingQualifications() {
        val details = SupportProgramStartupDetails(listOf("3년미만"), listOf("일반기업"), listOf("만 40세 이상"))
        val match = candidate("match", sourceCode = "KSTARTUP", regions = listOf("서울"), categories = listOf("사업화"))
            .copy(startupDetails = details)
        snapshot(
            match,
            match.copy(program = match.program.copy(id = "missing"), startupDetails = null),
            match.copy(program = match.program.copy(id = "different-stage"), startupDetails = details.copy(startupStages = listOf("7년미만"))),
            match.copy(program = match.program.copy(id = "different-target"), startupDetails = details.copy(applicantTypes = listOf("대학생"))),
            match.copy(program = match.program.copy(id = "different-age"), startupDetails = details.copy(founderAges = emptyList())),
            candidate("bizinfo-same-words", title = "3년미만 일반기업 만 40세 이상"),
        )

        val result = service.browse(
            rawRegion = "서울", rawCategory = "사업화", sourceCode = "KSTARTUP",
            rawStartupStage = " 3년미만 ", rawApplicantType = "일반기업", rawFounderAge = "만 40세 이상",
        )

        assertEquals(listOf("match"), result.programs.map { it.id })
        assertEquals(listOf("3년미만", "7년미만"), result.startupStages)
        assertEquals(listOf("대학생", "일반기업"), result.applicantTypes)
        assertEquals(listOf("만 40세 이상"), result.founderAges)
    }

    @Test
    fun startupFacetsSurviveEmptyResultsAndNeverComeFromAnotherSource() {
        snapshot(candidate("startup", sourceCode = "KSTARTUP").copy(
            startupDetails = SupportProgramStartupDetails(listOf("예비창업자", "예비창업자", " "), listOf("일반인"), emptyList()),
        ))

        val result = service.browse(sourceCode = "BIZINFO")

        assertTrue(result.programs.isEmpty())
        assertEquals(listOf("예비창업자"), result.startupStages)
        assertEquals(listOf("일반인"), result.applicantTypes)
        assertTrue(result.founderAges.isEmpty())
    }

    @ParameterizedTest
    @ValueSource(strings = ["MSIT", "CNTRADE_NOTICE"])
    fun noticeSourcesFilterByIdentityWithoutInventingDatesOrTags(source: String) {
        snapshot(*listOf("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE").map {
            candidate("same", sourceCode = it, status = SupportProgramStatus.UNKNOWN, regions = emptyList(), categories = emptyList())
        }.toTypedArray())

        val result = service.browse(sourceCode = source, status = SupportProgramStatus.UNKNOWN)

        assertEquals(listOf("$source:same"), result.programs.map { it.sourceQualifiedId })
        assertTrue(result.regions.isEmpty())
        assertTrue(result.categories.isEmpty())
    }

    @ParameterizedTest
    @ValueSource(strings = ["MSIT", "CNTRADE_NOTICE"])
    fun noticeSourcesDoNotTreatUnknownAsOpen(source: String) {
        snapshot(candidate("notice", sourceCode = source, status = SupportProgramStatus.UNKNOWN))

        assertEquals(0, service.browse(sourceCode = source).total)
    }

    private fun candidate(
        id: String,
        sourceCode: String = "BIZINFO",
        title: String = "기업 지원사업",
        organization: String = "지원기관",
        summary: String = "공식 지원 내용",
        regions: List<String> = listOf("전국"),
        categories: List<String> = listOf("경영"),
        status: SupportProgramStatus = SupportProgramStatus.OPEN,
        endDate: LocalDate? = null,
        timestamp: String = "2026-09-01",
    ) = CatalogSupportProgram(
        program = SupportProgram(
            id = id,
            sourceCode = sourceCode,
            title = title,
            organization = organization,
            summary = summary,
            categories = categories,
            regions = regions,
            targetDescription = "중소기업",
            applicationPeriod = "상시 접수",
            applicationStartDate = null,
            applicationEndDate = endDate,
            status = status,
            sourceName = "기업마당",
            sourceUrl = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=$id",
            matchedReasons = emptyList(),
        ),
        sortTimestamp = timestamp,
    )
}
