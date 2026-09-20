package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramRankingClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEligibility
import ai.govbiz.core.supportprogram.client.ai.dto.AiScoredSupportProgramPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEligibilityEvidencePayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEligibilityEvidenceField
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReviewStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityStatus
import org.junit.jupiter.api.Assertions.assertTrue
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramCompanyConditionsRequest
import java.time.LocalDate
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class AiSupportProgramRankingFacadeTest {

    private val client = StubRankingClient()

    @Test
    fun passesRegisteredFoundationYearToAiWithoutInventingADate() {
        client.reset(response())
        facade().rank(QUERY, candidates(), 5,
            SupportProgramCompanyConditions(region = "서울특별시", industry = "정보통신업", foundedYear = 2021),
            LocalDate.of(2026, 9, 16))
        assertEquals(
            AiSupportProgramCompanyConditionsRequest("서울특별시", "정보통신업", null, null, "2026-09-16", 2021),
            client.requests.single().companyConditions,
        )
    }

    @Test
    fun sendsTheVersionedScoringContractAndMapsValidatedRankings() {
        val candidates = candidates()
        client.response = response(
            score("second", semantic = 40, total = 90, reason = "질의와 직접 관련"),
            score("first", semantic = 20, total = 50, reason = "일부 관련"),
        )

        val programs = facade().rank(QUERY, candidates, 5)

        val request = client.requests.single()
        assertEquals(null, request.companyConditions)
        assertEquals(AiSupportProgramRankingFacade.SCORING_VERSION, request.scoringVersion)
        assertEquals(2, request.resultLimit)
        assertEquals(listOf("BIZINFO:first", "BIZINFO:second"), request.candidates.map { it.id })
        assertEquals(listOf("second", "first"), programs.map { it.id })
        assertEquals(90, programs.first().recommendationScore)
        assertEquals(listOf("질의와 직접 관련"), programs.first().matchedReasons)
        assertEquals(SupportProgramEligibilityReviewStatus.MATCH, programs.first().eligibilityReview?.status)
        assertEquals("중소기업", programs.first().eligibilityReview?.target?.evidence?.single()?.quote)
    }

    @Test
    fun acceptsFewerRankingsWhenOnlySomeCandidatesMeetTheRecommendationMinimum() {
        client.reset(response(score("second", semantic = 40, total = 90, reason = "질의와 직접 관련")))

        val programs = facade().rank(QUERY, candidates(), 5)

        assertEquals(listOf("second"), programs.map { it.id })
        assertEquals(90, programs.single().recommendationScore)
    }

    @Test
    fun distinguishesCandidatesWithTheSameRawIdFromDifferentSources() {
        val bizInfo = CatalogSupportProgram(program("SHARED", "BIZINFO"), "2026-08-20")
        val other = CatalogSupportProgram(program("SHARED", "OTHER"), "2026-08-21")
        client.reset(
            response(
                qualifiedScore("OTHER:SHARED", semantic = 40, total = 90, reason = "다른 제공처 공고"),
                qualifiedScore("BIZINFO:SHARED", semantic = 20, total = 50, reason = "기업마당 공고"),
            ),
        )

        val programs = facade().rank(QUERY, listOf(bizInfo, other), 5)

        assertEquals(
            listOf("BIZINFO:SHARED", "OTHER:SHARED"),
            client.requests.single().candidates.map { it.id },
        )
        assertEquals(listOf("OTHER", "BIZINFO"), programs.map { it.sourceCode })
        assertEquals(listOf("SHARED", "SHARED"), programs.map { it.id })
    }

    @Test
    fun acceptsAnEmptyRankingWhenNoCandidateMeetsTheRecommendationMinimum() {
        client.reset(response())

        assertEquals(emptyList<SupportProgram>(), facade().rank(QUERY, candidates(), 5))
    }

    @Test
    fun truncatesCandidateTextAtCodePointBoundariesWithoutSplittingSupplementaryCharacters() {
        val candidate = candidates().first().let { candidate ->
            candidate.copy(
                program = candidate.program.copy(
                    title = "가".repeat(299) + "🚀추가",
                    organization = "가".repeat(199) + "🚀추가",
                    summary = "가".repeat(5999) + "🚀추가",
                    targetDescription = "가".repeat(1999) + "🚀추가",
                    applicationPeriod = "가".repeat(199) + "🚀추가",
                    categories = listOf("가".repeat(99) + "🚀추가"),
                    regions = listOf("가".repeat(99) + "🚀추가"),
                ),
            )
        }
        client.reset(response())

        facade().rank(QUERY, listOf(candidate), 5)

        val sent = client.requests.single().candidates.single()
        assertEquals("가".repeat(299) + "🚀", sent.title)
        assertEquals("가".repeat(199) + "🚀", sent.organization)
        assertEquals("가".repeat(5999) + "🚀", sent.summary)
        assertEquals("가".repeat(1999) + "🚀", sent.targetDescription)
        assertTrue(sent.sourceTextTruncated)
        assertEquals("가".repeat(199) + "🚀", sent.applicationPeriod)
        assertEquals(listOf("가".repeat(99) + "🚀"), sent.categories)
        assertEquals(listOf("가".repeat(99) + "🚀"), sent.regions)
    }

    @Test
    fun acceptsRecommendationReasonsAtTheAiContractCodePointLimit() {
        val reason = "가".repeat(119) + "🚀"
        client.reset(response(score("first", 40, 90, reason)))

        val programs = facade().rank(QUERY, candidates(), 5)

        assertEquals(listOf(reason), programs.single().matchedReasons)
    }

    @Test
    fun rejectsRecommendationReasonsAboveTheAiContractCodePointLimit() {
        client.reset(response(score("first", 40, 90, "가".repeat(120) + "🚀")))

        assertInvalidResponse()
    }

    @Test
    fun rejectsMoreRankingsThanTheRequestedLimit() {
        client.reset(
            response(
                score("second", semantic = 40, total = 90, reason = "질의와 직접 관련"),
                score("first", semantic = 20, total = 50, reason = "일부 관련"),
            ),
        )

        val exception = assertThrows(AiServiceCallException::class.java) {
            facade().rank(QUERY, candidates(), 1)
        }

        assertEquals(AiServiceFailure.INVALID_RESPONSE, exception.failure)
    }

    @Test
    fun rejectsUnknownDuplicateAndAscendingProgramIds() {
        val invalidPayloads = listOf(
            response(score("unknown", 40, 90, "근거"), score("first", 20, 50, "근거 2")),
            response(score("first", 40, 90, "근거"), score("first", 20, 50, "근거 2")),
            response(score("first", 20, 50, "근거"), score("second", 40, 90, "근거 2")),
        )

        invalidPayloads.forEach { payload ->
            client.reset(payload)

            assertInvalidResponse()
        }
    }

    @Test
    fun rejectsRankingsBelowTheSemanticMinimumEvenWithMaximumSupportTypeScore() {
        client.reset(response(score("first", semantic = 19, total = 58, reason = "간접 관련", supportType = 10)))
        assertInvalidResponse()
    }

    @Test
    fun acceptsRelevantUnknownWithoutTheOldTotalScoreGate() {
        client.reset(response(score(
            "first", semantic = 20, total = 40, reason = "요청 지원 일부 제공", supportType = 0,
            targetEligibility = AiSupportProgramEligibility.UNKNOWN,
            regionEligibility = AiSupportProgramEligibility.UNKNOWN,
        )))
        val result = facade().rank(QUERY, candidates(), 5).single()
        assertEquals(40, result.recommendationScore)
        assertEquals(SupportProgramEligibilityReviewStatus.REVIEW_REQUIRED, result.eligibilityReview?.status)
    }

    @Test
    fun rejectsAnIncompatibleTargetOrRegionEvenWhenTheTotalScoreIsHigh() {
        val invalidPayloads = listOf(
            response(
                score(
                    "first",
                    semantic = 40,
                    total = 90,
                    reason = "서울 AI 공고",
                    targetEligibility = AiSupportProgramEligibility.INCOMPATIBLE,
                ),
            ),
            response(
                score(
                    "first",
                    semantic = 40,
                    total = 90,
                    reason = "AI 기업 지원",
                    regionEligibility = AiSupportProgramEligibility.INCOMPATIBLE,
                ),
            ),
        )

        invalidPayloads.forEach { payload ->
            client.reset(payload)

            assertInvalidResponse()
        }
    }

    @Test
    fun acceptsUnknownEligibilityWhenTheCandidateOtherwiseMeetsTheRecommendationMinimum() {
        client.reset(
            response(
                score(
                    "first",
                    semantic = 40,
                    total = 90,
                    reason = "질의와 관련된 지원사업",
                    supportType = 5,
                    targetEligibility = AiSupportProgramEligibility.UNKNOWN,
                    regionEligibility = AiSupportProgramEligibility.UNKNOWN,
                ),
            ),
        )

        val result = facade().rank(QUERY, candidates(), 5).single()
        assertEquals("first", result.id)
        assertEquals(SupportProgramEligibilityReviewStatus.REVIEW_REQUIRED, result.eligibilityReview?.status)
        assertEquals(SupportProgramEligibilityStatus.UNKNOWN, result.eligibilityReview?.target?.status)
        assertEquals(emptyList<Any>(), result.eligibilityReview?.target?.evidence)
    }

    @Test
    fun rejectsWrongEchoVersionScoreSumAndReasons() {
        val validScores = arrayOf(
            score("second", 40, 90, "직접 관련"),
            score("first", 20, 50, "일부 관련"),
        )
        val invalidPayloads = listOf(
            response(*validScores).copy(originalQuery = "변조된 질의"),
            response(*validScores).copy(scoringVersion = "stale-version"),
            response(
                validScores[0].copy(totalScore = 84),
                validScores[1],
            ),
            response(
                validScores[0].copy(recommendationReasons = emptyList()),
                validScores[1],
            ),
        )

        invalidPayloads.forEach { payload ->
            client.reset(payload)

            assertInvalidResponse()
        }
    }

    @Test
    fun rejectsMissingFabricatedWrongFieldAndMalformedEvidence() {
        val valid = score("first", 40, 90, "공식 본문 근거")
        val targetEvidence = valid.targetEvidence!!
        val regionEvidence = valid.regionEvidence!!.single()!!
        val invalid = listOf(
            valid.copy(targetEvidence = null),
            valid.copy(targetEvidence = emptyList()),
            valid.copy(targetEvidence = listOf(null)),
            valid.copy(targetEvidence = targetEvidence + targetEvidence),
            valid.copy(targetExplanation = null),
            valid.copy(targetExplanation = " "),
            valid.copy(targetExplanation = "가".repeat(161)),
            valid.copy(targetExplanation = "본문\n근거"),
            valid.copy(regionEvidence = listOf(regionEvidence.copy(field = null))),
            valid.copy(regionEvidence = listOf(regionEvidence.copy(quote = null))),
            valid.copy(regionEvidence = listOf(regionEvidence.copy(quote = "경북 소재 기업만 신청 가능"))),
            valid.copy(regionEvidence = listOf(regionEvidence.copy(quote = "서울  소재 중소기업 대상."))),
            valid.copy(regionEvidence = listOf(regionEvidence.copy(field = AiSupportProgramEligibilityEvidenceField.TARGET_DESCRIPTION))),
            valid.copy(regionEvidence = listOf(regionEvidence.copy(quote = "first 지원사업"))),
            valid.copy(regionEvidence = listOf(regionEvidence.copy(quote = "AI"))),
            valid.copy(regionEvidence = listOf(regionEvidence.copy(quote = "\t"))),
        )
        for (ranking in invalid) {
            client.reset(response(ranking))
            assertInvalidResponse()
        }
    }

    @Test
    fun preservesExactQuotesAndCountsSupplementaryCharactersAsOneCodePoint() {
        val quote = "가".repeat(239) + "🚀"
        val explanation = "가".repeat(159) + "🚀"
        val candidate = candidates().first().let { it.copy(program = it.program.copy(summary = quote + "추가")) }
        val valid = score("first", 40, 90, "근거").copy(
            regionEvidence = listOf(AiSupportProgramEligibilityEvidencePayload(AiSupportProgramEligibilityEvidenceField.SUMMARY, quote)),
            regionExplanation = explanation,
        )
        client.reset(response(valid))
        val result = facade().rank(QUERY, listOf(candidate), 5).single()
        assertEquals(quote, result.eligibilityReview?.region?.evidence?.single()?.quote)
        assertEquals(explanation, result.eligibilityReview?.region?.explanation)

        client.reset(response(valid.copy(regionEvidence = listOf(valid.regionEvidence!!.single()!!.copy(quote = quote + "추")))))
        assertThrows(AiServiceCallException::class.java) { facade().rank(QUERY, listOf(candidate), 5) }
    }

    @Test
    fun truncatedSourceCanOnlyProduceUnknownReviewsAndCannotCiteOmittedText() {
        val candidate = candidates().first().let { it.copy(program = it.program.copy(summary = "가".repeat(6000) + "숨겨진 요건")) }
        client.reset(response(score("first", 40, 90, "근거")))
        assertThrows(AiServiceCallException::class.java) { facade().rank(QUERY, listOf(candidate), 5) }

        val unknown = score("first", 40, 90, "근거", targetEligibility = AiSupportProgramEligibility.UNKNOWN, regionEligibility = AiSupportProgramEligibility.UNKNOWN)
        client.reset(response(unknown))
        assertEquals(SupportProgramEligibilityReviewStatus.REVIEW_REQUIRED, facade().rank(QUERY, listOf(candidate), 5).single().eligibilityReview?.status)
        client.reset(response(unknown.copy(regionEvidence = listOf(AiSupportProgramEligibilityEvidencePayload(AiSupportProgramEligibilityEvidenceField.SUMMARY, "숨겨진 요건")))))
        assertThrows(AiServiceCallException::class.java) { facade().rank(QUERY, listOf(candidate), 5) }
    }

    @Test
    fun keepsCompleteSourceAtTheExactLimitsAndDoesNotTreatTruncatedTagsAsSourceLoss() {
        val candidate = candidates().first().let { it.copy(program = it.program.copy(
            summary = "가".repeat(5999) + "🚀",
            targetDescription = "나".repeat(1999) + "🚀",
            title = "제목".repeat(300),
            regions = listOf("태그".repeat(100)),
        )) }
        client.reset(response())
        facade().rank(QUERY, listOf(candidate), 5)
        assertEquals(false, client.requests.single().candidates.single().sourceTextTruncated)
    }

    @Test
    fun unknownReviewsCanQuoteAvailableRequirementsWithoutClaimingAMatch() {
        val unknown = score("first", 40, 90, "근거", targetEligibility = AiSupportProgramEligibility.UNKNOWN)
            .copy(targetEvidence = listOf(AiSupportProgramEligibilityEvidencePayload(AiSupportProgramEligibilityEvidenceField.TARGET_DESCRIPTION, "중소기업")))
        client.reset(response(unknown))
        val review = facade().rank(QUERY, candidates(), 5).single().eligibilityReview!!
        assertEquals(SupportProgramEligibilityReviewStatus.REVIEW_REQUIRED, review.status)
        assertEquals("중소기업", review.target.evidence.single().quote)
    }

    @Test
    fun higherRelevanceUnknownPrecedesLowerRelevanceMatch() {
        val match = score("first", 20, 50, "충족")
        val unknown = score("second", 40, 90, "미확인", regionEligibility = AiSupportProgramEligibility.UNKNOWN)
        client.reset(response(unknown, match))
        assertEquals(listOf("second", "first"), facade().rank(QUERY, candidates(), 5).map { it.id })
        client.reset(response(match, unknown))
        assertInvalidResponse()
    }

    @Test
    fun unknownResultsStillRequireDescendingScores() {
        val lower = score("first", 20, 50, "미확인", regionEligibility = AiSupportProgramEligibility.UNKNOWN)
        val higher = score("second", 40, 90, "미확인", targetEligibility = AiSupportProgramEligibility.UNKNOWN)
        client.reset(response(lower, higher))
        assertInvalidResponse()
        client.reset(response(higher, lower))
        assertEquals(listOf("second", "first"), facade().rank(QUERY, candidates(), 5).map { it.id })
    }

    @Test
    fun tiesPreserveCandidateOrderRegardlessOfEligibility() {
        val unknown = score("first", 40, 90, "미확인", targetEligibility = AiSupportProgramEligibility.UNKNOWN)
        val match = score("second", 40, 90, "조건 확인")
        client.reset(response(unknown, match))
        assertEquals(listOf("first", "second"), facade().rank(QUERY, candidates(), 5).map { it.id })
        client.reset(response(match, unknown))
        assertInvalidResponse()
    }

    @Test
    fun rejectsMissingOrOutOfRangeRelevanceDimensions() {
        val valid = score("first", 40, 90, "근거")
        val invalid = listOf(
            valid.copy(semanticRelevance = null),
            valid.copy(semanticRelevance = -1, totalScore = 8),
            valid.copy(semanticRelevance = 41, totalScore = 92),
            valid.copy(supportTypeFit = null),
            valid.copy(supportTypeFit = -1, totalScore = 78),
            valid.copy(semanticRelevance = 30, supportTypeFit = 11, totalScore = 82),
            valid.copy(totalScore = null),
            valid.copy(totalScore = -1),
            valid.copy(totalScore = 101),
        )
        invalid.forEach { ranking ->
            client.reset(response(ranking))
            assertInvalidResponse()
        }
    }

    @Test
    fun rejectsControlCharactersEvenWhenTheQuoteExistsExactlyInTheSource() {
        for (control in listOf("\n", "\r", "\t", "\u0000", "\u200b")) {
            val quote = "서울${control}소재 기업"
            val candidate = candidates().first().let { it.copy(program = it.program.copy(summary = quote)) }
            client.reset(response(score("first", 40, 90, "근거").copy(
                regionEvidence = listOf(AiSupportProgramEligibilityEvidencePayload(AiSupportProgramEligibilityEvidenceField.SUMMARY, quote)),
            )))
            assertThrows(AiServiceCallException::class.java) { facade().rank(QUERY, listOf(candidate), 5) }
        }
    }

    @Test
    fun unknownStillRequiresAnExplanationAndAnExplicitEvidenceList() {
        val unknown = score("first", 40, 90, "근거", targetEligibility = AiSupportProgramEligibility.UNKNOWN)
        for (invalid in listOf(unknown.copy(targetExplanation = null), unknown.copy(targetEvidence = null))) {
            client.reset(response(invalid))
            assertInvalidResponse()
        }
    }

    private fun assertInvalidResponse() {
        val exception = assertThrows(AiServiceCallException::class.java) {
            facade().rank(QUERY, candidates(), 5)
        }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, exception.failure)
    }

    private fun facade() = AiSupportProgramRankingFacade(client)

    @Test
    fun passesExplicitConditionsAndCoreReferenceDateWithoutChangingTheOriginalQuery() {
        client.reset(response())
        val conditions = SupportProgramCompanyConditions("부산", "제조업", LocalDate.of(2024, 2, 29), "시제품")

        facade().rank(QUERY, candidates(), 5, conditions, LocalDate.of(2026, 9, 7))

        val request = client.requests.single()
        assertEquals(QUERY, request.originalQuery)
        assertEquals(AiSupportProgramCompanyConditionsRequest("부산", "제조업", "2024-02-29", "시제품", "2026-09-07"), request.companyConditions)
    }

    @Test
    fun refusesConditionsWithoutAReferenceDateBeforeCallingAi() {
        assertThrows(IllegalArgumentException::class.java) {
            facade().rank(QUERY, candidates(), 5, SupportProgramCompanyConditions(region = "서울"))
        }
        assertEquals(emptyList<AiSupportProgramRankingRequest>(), client.requests)
    }

    private fun candidates() = listOf(
        CatalogSupportProgram(program("first"), "2026-08-20"),
        CatalogSupportProgram(program("second"), "2026-08-21"),
    )

    private fun program(id: String, sourceCode: String = "BIZINFO") = SupportProgram(
        id = id,
        sourceCode = sourceCode,
        title = "$id 지원사업",
        organization = "기관",
        summary = "$id 기업을 지원합니다. 서울 소재 중소기업 대상.",
        categories = listOf("AI"),
        regions = listOf("서울"),
        targetDescription = "중소기업",
        applicationPeriod = "상시 접수",
        applicationStartDate = null,
        applicationEndDate = null,
        status = SupportProgramStatus.OPEN,
        sourceName = if (sourceCode == "BIZINFO") "기업마당" else sourceCode,
        sourceUrl = "https://${sourceCode.lowercase()}.example/$id",
        matchedReasons = emptyList(),
    )

    private fun response(vararg scores: AiScoredSupportProgramPayload) =
        AiSupportProgramRankingPayload(
            originalQuery = QUERY,
            scoringVersion = AiSupportProgramRankingFacade.SCORING_VERSION,
            rankings = scores.toList(),
        )

    private fun score(
        id: String,
        semantic: Int,
        total: Int,
        reason: String,
        supportType: Int = 5,
        targetEligibility: AiSupportProgramEligibility = AiSupportProgramEligibility.MATCH,
        regionEligibility: AiSupportProgramEligibility = AiSupportProgramEligibility.MATCH,
    ) = qualifiedScore(
        programId = "BIZINFO:$id",
        semantic = semantic,
        total = total,
        reason = reason,
        supportType = supportType,
        targetEligibility = targetEligibility,
        regionEligibility = regionEligibility,
    )

    private fun qualifiedScore(
        programId: String,
        semantic: Int,
        total: Int,
        reason: String,
        supportType: Int = 5,
        targetEligibility: AiSupportProgramEligibility = AiSupportProgramEligibility.MATCH,
        regionEligibility: AiSupportProgramEligibility = AiSupportProgramEligibility.MATCH,
    ) = AiScoredSupportProgramPayload(
        programId = programId,
        semanticRelevance = semantic,
        targetEligibility = targetEligibility,
        regionEligibility = regionEligibility,
        supportTypeFit = supportType,
        totalScore = total,
        recommendationReasons = listOf(reason),
        targetEvidence = if (targetEligibility == AiSupportProgramEligibility.UNKNOWN) emptyList() else listOf(
            AiSupportProgramEligibilityEvidencePayload(AiSupportProgramEligibilityEvidenceField.TARGET_DESCRIPTION, "중소기업"),
        ),
        targetExplanation = if (targetEligibility == AiSupportProgramEligibility.UNKNOWN) "추가 기업 정보가 없어 지원대상을 확인할 수 없습니다." else "공식 API 지원대상에 중소기업이 명시되어 있습니다.",
        regionEvidence = if (regionEligibility == AiSupportProgramEligibility.UNKNOWN) emptyList() else listOf(
            AiSupportProgramEligibilityEvidencePayload(AiSupportProgramEligibilityEvidenceField.SUMMARY, "서울 소재 중소기업 대상."),
        ),
        regionExplanation = if (regionEligibility == AiSupportProgramEligibility.UNKNOWN) "소재지 조건을 확인할 추가 정보가 필요합니다." else "공식 API 본문에 서울 소재 요건이 명시되어 있습니다.",
    )

    private companion object {
        const val QUERY = "서울 AI 지원사업"
    }

    private class StubRankingClient : AiSupportProgramRankingClient {
        val requests = mutableListOf<AiSupportProgramRankingRequest>()
        lateinit var response: AiSupportProgramRankingPayload

        override fun rankSupportPrograms(
            request: AiSupportProgramRankingRequest,
        ): AiSupportProgramRankingPayload {
            requests += request
            return response
        }

        fun reset(nextResponse: AiSupportProgramRankingPayload) {
            requests.clear()
            response = nextResponse
        }
    }
}
