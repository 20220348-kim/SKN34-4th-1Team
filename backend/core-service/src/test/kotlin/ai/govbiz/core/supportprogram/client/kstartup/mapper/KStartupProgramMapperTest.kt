package ai.govbiz.core.supportprogram.client.kstartup.mapper

import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramRankingClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest
import ai.govbiz.core.supportprogram.client.kstartup.dto.KStartupProgramPayload
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupClientException
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.AiSupportProgramRankingFacade
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

class KStartupProgramMapperTest {
    @Test
    fun mapsNativeCategoriesAndStartupDetailsWithoutReplacingOriginalEligibility() {
        val catalog = map(payload())
        val program = catalog.program
        assertEquals("179197", program.id)
        assertEquals("KSTARTUP", program.sourceCode)
        assertEquals("K-Startup", program.sourceName)
        assertEquals("스타트업 법률지원 모집", program.title)
        assertEquals("창업진흥원 원스톱지원실", program.organization)
        assertEquals("법률 상담 & 교육", program.summary)
        assertEquals(listOf("멘토링ㆍ컨설팅ㆍ교육", "기술개발(R&D)"), program.categories)
        assertEquals(listOf("전국"), program.regions)
        assertEquals(listOf("예비창업자", "1년미만", "7년미만"), catalog.startupDetails!!.startupStages)
        assertEquals(listOf("일반인", "일반기업"), catalog.startupDetails!!.applicantTypes)
        assertEquals(listOf("만 20세 미만", "만 40세 이상"), catalog.startupDetails!!.founderAges)
        assertEquals(
            "지원 대상: 예비창업자 및 창업기업(신산업의 경우 10년 이내)\n" +
                "제외 대상: 창업에서 제외되는 업종",
            program.targetDescription,
        )
        assertEquals(LocalDate.of(2026, 9, 8), program.applicationStartDate)
        assertEquals(LocalDate.of(2026, 9, 11), program.applicationEndDate)
        assertEquals("2026-09-08 ~ 2026-09-11", program.applicationPeriod)
        assertEquals(SupportProgramStatus.OPEN, program.status)
        assertEquals("2026-09-08", catalog.sortTimestamp)
        assertEquals(DETAIL_URL, program.sourceUrl)
        assertNull(program.recommendationScore)
        assertEquals(emptyList<String>(), program.matchedReasons)
    }

    @Test
    fun sendsOnlyOriginalEligibilityTextToTheRankingCandidateWithoutClassifications() {
        val catalog = map(payload())
        val requests = mutableListOf<AiSupportProgramRankingRequest>()
        val ranking = AiSupportProgramRankingFacade(AiSupportProgramRankingClient { request ->
            requests += request
            AiSupportProgramRankingPayload(request.originalQuery, request.scoringVersion, emptyList())
        })

        ranking.rank("법률지원", listOf(catalog), 1)

        val candidate = requests.single().candidates.single()
        assertEquals(catalog.program.targetDescription, candidate.targetDescription)
        assertEquals("지원 대상: 예비창업자 및 창업기업(신산업의 경우 10년 이내)\n제외 대상: 창업에서 제외되는 업종", candidate.targetDescription)
        assertFalse(candidate.targetDescription.contains("분류"))
        assertFalse(candidate.targetDescription.contains("1년미만"))
        assertFalse(candidate.targetDescription.contains("만 40세 이상"))
        assertFalse(candidate.targetDescription.contains("일반기업"))
    }

    @Test
    fun classificationsAloneDoNotBecomeOriginalEligibilityEvidence() {
        val catalog = map(payload().copy(target = null, excludedTarget = null))
        assertEquals("정보 없음", catalog.program.targetDescription)
        assertEquals(listOf("예비창업자", "1년미만", "7년미만"), catalog.startupDetails!!.startupStages)
    }

    @Test
    fun normalizesOfficialRegionsIncludingTheExplicitJeonnamGwangjuCombination() {
        assertEquals(listOf("서울", "전남", "광주", "강원", "전북", "제주", "새 지역"), map(payload().copy(
            region = "서울특별시,전남광주,광주광역시,강원특별자치도,전북특별자치도,제주특별자치도,새 지역",
        )).program.regions)
        assertEquals(listOf("전국"), map(payload().copy(region = "서울,전국,부산")).program.regions)
        assertEquals(emptyList<String>(), map(payload().copy(region = null)).program.regions)
    }

    @Test
    fun preservesMissingAndInvalidDatesWithoutInventingAnApplicationPeriod() {
        val missing = map(payload().copy(applicationStartDate = null, applicationEndDate = null))
        assertNull(missing.program.applicationStartDate)
        assertNull(missing.program.applicationEndDate)
        assertEquals("정보 없음", missing.program.applicationPeriod)
        assertEquals(SupportProgramStatus.UNKNOWN, missing.program.status)
        assertEquals("", missing.sortTimestamp)

        val malformed = map(payload().copy(applicationStartDate = "20260230", applicationEndDate = "미정"))
        assertNull(malformed.program.applicationStartDate)
        assertNull(malformed.program.applicationEndDate)
        assertEquals("20260230 ~ 미정", malformed.program.applicationPeriod)
        assertEquals(SupportProgramStatus.UNKNOWN, malformed.program.status)
        assertEquals("", malformed.sortTimestamp)
    }

    @Test
    fun resolvesDatesAgainstTheProvidedTodayIncludingEndOnlyAndUpcomingPrograms() {
        assertEquals(SupportProgramStatus.CLOSED, map(payload(), LocalDate.of(2026, 9, 12)).program.status)
        assertEquals(SupportProgramStatus.UPCOMING, map(payload(), LocalDate.of(2026, 9, 7)).program.status)
        val endOnly = map(payload().copy(applicationStartDate = null))
        assertNull(endOnly.program.applicationStartDate)
        assertEquals("시작일 미정 ~ 2026-09-11", endOnly.program.applicationPeriod)
        assertEquals(SupportProgramStatus.OPEN, endOnly.program.status)
    }

    @Test
    fun rejectsAReversedPeriodInsteadOfPublishingIt() {
        invalid(payload().copy(applicationStartDate = "20260912"))
    }

    @Test
    fun stripsExecutableMarkupAndKeepsEmptyMetadataAsEmptyLists() {
        val catalog = map(payload().copy(
            title = "<script>secret()</script><b>제목</b>", organization = " ",
            summaryHtml = "<style>hidden</style><script>secret()</script>", target = null,
            excludedTarget = null, applicantTypes = " , ", startupStages = null, founderAges = "",
        ))
        assertEquals("제목", catalog.program.title)
        assertEquals("정보 없음", catalog.program.organization)
        assertEquals("정보 없음", catalog.program.summary)
        assertEquals("정보 없음", catalog.program.targetDescription)
        assertEquals(emptyList<String>(), catalog.startupDetails!!.startupStages)
        assertEquals(emptyList<String>(), catalog.startupDetails!!.applicantTypes)
        assertEquals(emptyList<String>(), catalog.startupDetails!!.founderAges)
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "0", "-1", "01", " 179197", "179197 ", "abc", "1.5"])
    fun rejectsNoncanonicalStableIds(id: String) { invalid(payload().copy(id = id)) }

    @Test
    fun rejectsMissingIdsDuplicateIdsAndMissingTitles() {
        invalid(payload().copy(id = null))
        invalid(payload().copy(id = "1".repeat(256)))
        invalid(payload().copy(title = "<script>empty</script>"))
        assertThrows(KStartupClientException::class.java) {
            KStartupProgramMapper.mapValidated(listOf(payload(), payload()), TODAY)
        }
    }

    @ParameterizedTest
    @ValueSource(strings = [
        "https://attacker.test/detail?pbancSn=179197",
        "https://k-startup.go.kr.attacker.test/detail?pbancSn=179197",
        "http://www.k-startup.go.kr/detail?pbancSn=179197",
        "https://user@www.k-startup.go.kr/detail?pbancSn=179197",
        "https://www.k-startup.go.kr:444/detail?pbancSn=179197",
        "https://www.k-startup.go.kr/?pbancSn=179197",
        "https://www.k-startup.go.kr/detail?pbancSn=179198",
        "https://www.k-startup.go.kr/detail?pbancSn=179197&pbancSn=179197",
        "https://www.k-startup.go.kr/detail?pbancSn=179197#fragment",
        "https://www.k-startup.go.kr/detail?id=179197",
        "https://www.k-startup.go.kr/detail?pbancSn=%zz",
        "javascript:alert(1)",
    ])
    fun rejectsUnsafeOrNonmatchingOfficialUrls(url: String) {
        val failure = invalid(payload().copy(sourceUrl = url))
        assertFalse(failure.stackTraceToString().contains(url))
    }

    @Test
    fun permitsOfficialHttpsSubdomainsDefaultPortAndAnEncodedMatchingId() {
        val url = "https://k-startup.go.kr:443/detail?pbancSn=%31%37%39%31%39%37"
        assertEquals(url, map(payload().copy(sourceUrl = url)).program.sourceUrl)
        invalid(payload().copy(sourceUrl = null))
    }

    @Test
    fun rejectsDatabaseSizeOverflowBeforeIndexingAndCountsUnicodeCharactersCorrectly() {
        invalid(payload().copy(title = "가".repeat(501)))
        invalid(payload().copy(organization = "가".repeat(256)))
        invalid(payload().copy(sourceUrl = "$DETAIL_URL&extra=${"x".repeat(2048)}"))
        invalid(payload().copy(summaryHtml = "가".repeat(21_846)))
        invalid(payload().copy(target = "가".repeat(21_846)))
        invalid(payload().copy(applicationStartDate = "가".repeat(21_846)))
        assertEquals("😀".repeat(500), map(payload().copy(title = "😀".repeat(500))).program.title)
        assertEquals("가".repeat(21_845), map(payload().copy(summaryHtml = "가".repeat(21_845))).program.summary)
    }

    @Test
    fun doesNotMutateInputAndReturnsImmutableOrderedLists() {
        val first = payload()
        val second = payload().copy(id = "179198", sourceUrl = DETAIL_URL.replace("179197", "179198"))
        val input = mutableListOf(first, second)
        val output = KStartupProgramMapper.mapValidated(input, TODAY)
        assertEquals(listOf(first, second), input)
        assertEquals(listOf("179197", "179198"), output.map { it.program.id })
        input.clear()
        assertEquals(2, output.size)
        assertThrows(UnsupportedOperationException::class.java) { (output as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (output[0].program.categories as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (output[0].startupDetails!!.startupStages as MutableList).clear() }
    }

    private fun invalid(payload: KStartupProgramPayload): KStartupClientException {
        val error = assertThrows(KStartupClientException::class.java) { map(payload) }
        assertEquals(KStartupClientException.Failure.INVALID_RESPONSE, error.failure)
        return error
    }
    private fun map(payload: KStartupProgramPayload, today: LocalDate = TODAY) =
        KStartupProgramMapper.mapValidated(listOf(payload), today).single()

    private fun payload() = KStartupProgramPayload(
        id = "179197", title = "스타트업 법률지원 모집", organization = "창업진흥원 원스톱지원실",
        summaryHtml = "<p>법률 상담 &amp; 교육</p>", target = "\t\r\n예비창업자 및 창업기업(신산업의 경우 10년 이내)",
        excludedTarget = "창업에서 제외되는 업종", applicantTypes = "일반인, 일반기업,일반인,",
        startupStages = "예비창업자,1년미만,7년미만", founderAges = "만 20세 미만,만 40세 이상",
        category = "멘토링ㆍ컨설팅ㆍ교육,기술개발(R&amp;D)", region = "전국",
        applicationStartDate = "20260908", applicationEndDate = "20260911", sourceUrl = DETAIL_URL,
    )

    private companion object {
        val TODAY: LocalDate = LocalDate.of(2026, 9, 9)
        const val DETAIL_URL = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=179197"
    }
}
