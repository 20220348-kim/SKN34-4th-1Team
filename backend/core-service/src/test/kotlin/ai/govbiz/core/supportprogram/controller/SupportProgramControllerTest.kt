package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.elasticsearch.exception.ElasticsearchClientException
import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityAssessment
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityEvidence
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityEvidenceField
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReview
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReviewStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.AiSupportProgramRetrievalFacade
import ai.govbiz.core.supportprogram.facade.SupportProgramRankingFacade
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.repository.SupportProgramSearchResultRepository
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceAnswerStatus
import ai.govbiz.core.supportprogram.service.dto.SupportProgramEvidenceCitationResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchReadinessResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchState
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSourceReadinessResult
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceNotSupportedException
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceUnavailableException
import ai.govbiz.core.supportprogram.service.readiness.SupportProgramSearchReadinessService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchPreviewService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.stream.Stream
import org.hamcrest.Matchers.containsString
import org.hamcrest.Matchers.not
import org.hamcrest.Matchers.nullValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mock
import org.mockito.Mockito
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.ResultActions
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class SupportProgramControllerTest {

    @Mock
    private lateinit var supportProgramRepository: SupportProgramRepository

    @Mock
    private lateinit var retrieval: AiSupportProgramRetrievalFacade

    @Mock
    private lateinit var evidenceService: SupportProgramEvidenceService

    @Mock
    private lateinit var readinessService: SupportProgramSearchReadinessService

    private lateinit var ranking: StubSupportProgramRankingFacade

    private lateinit var mockMvc: MockMvc

    @BeforeEach
    fun setUp() {
        ranking = StubSupportProgramRankingFacade()
        val service = SupportProgramSearchService(
            supportProgramRepository,
            ranking,
            retrieval,
            Clock.fixed(Instant.parse("2026-09-06T15:00:00Z"), ZoneId.of("Asia/Seoul")),
        )
        mockMvc = MockMvcBuilders
            .standaloneSetup(
                SupportProgramController(
                    searchService = SupportProgramSearchPreviewService(service, Mockito.mock(SupportProgramSearchResultRepository::class.java)),
                    readinessService = readinessService,
                    detailService = SupportProgramDetailService(supportProgramRepository),
                    evidenceService = evidenceService,
                    requestAdmissionService = SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties()),
                ),
            )
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver { Mockito.mock(AccountSessionService::class.java) })
            .setControllerAdvice(ApiExceptionHandler())
            .build()
    }

    @Test
    fun returnsTheStableFrontendContractIncludingNullableParsedDates() {
        Mockito.doReturn(listOf(catalogProgram())).`when`(retrieval)
            .retrieve("서울 AI", listOf(catalogProgram()))
        Mockito.doReturn(listOf(catalogProgram()))
            .`when`(supportProgramRepository)
            .findSearchablePresent()
        ranking.response = { candidates ->
            listOf(
                candidates.single().program.copy(
                    recommendationScore = 96,
                    matchedReasons = listOf("서울 AI 기업 대상"),
                ),
            )
        }

        mockMvc.perform(get(PATH).queryParam("query", "  서울 AI  "))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.query").value("서울 AI"))
            .andExpect(jsonPath("$.programs[0].id").value("PBLN_TEST"))
            .andExpect(jsonPath("$.programs[0].sourceCode").value("BIZINFO"))
            .andExpect(jsonPath("$.programs[0].status").value("OPEN"))
            .andExpect(jsonPath("$.programs[0].applicationPeriod").value("상시 접수"))
            .andExpect(jsonPath("$.programs[0].applicationStartDate").value(nullValue()))
            .andExpect(jsonPath("$.programs[0].applicationEndDate").value(nullValue()))
            .andExpect(jsonPath("$.programs[0].sourceName").value("기업마당"))
            .andExpect(jsonPath("$.programs[0].recommendationScore").value(96))
            .andExpect(jsonPath("$.programs[0].matchedReasons[0]").value("서울 AI 기업 대상"))
            .andExpect(
                jsonPath("$.programs[0].sourceUrl")
                    .value("https://www.bizinfo.go.kr/detail?id=PBLN_TEST"),
            )
    }

    @Test
    fun returnsAnEmptyListWhenTheCurrentCatalogIsEmpty() {
        Mockito.doReturn(emptyList<CatalogSupportProgram>())
            .`when`(supportProgramRepository)
            .findSearchablePresent()

        mockMvc.perform(get(PATH).queryParam("query", "서울"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.query").value("서울"))
            .andExpect(jsonPath("$.programs").isEmpty())
    }

    @ParameterizedTest
    @ValueSource(strings = ["서울\u0000AI", "서울\u200BAI", "서울\uE000AI", "서울\uD800AI"])
    fun rejectsUnreadableSearchQueriesBeforeCallingTheDatabaseOrAi(query: String) {
        mockMvc.perform(get(PATH).queryParam("query", query))
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.errors[0].field").value("query"))

        Mockito.verifyNoInteractions(supportProgramRepository, retrieval)
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "  \t\r\n", "서울\tAI\n기업\r지원", "서울 😀 AI"])
    fun keepsBlankAndReadableMultilineSearchQueriesSupported(query: String) {
        if (query.isBlank()) {
            Mockito.doReturn(emptyList<CatalogSupportProgram>())
                .`when`(supportProgramRepository).findPublishedPresent()
        } else {
            Mockito.doReturn(emptyList<CatalogSupportProgram>())
                .`when`(supportProgramRepository).findSearchablePresent()
        }

        mockMvc.perform(get(PATH).queryParam("query", query))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.query").value(query.trim()))

        Mockito.verifyNoInteractions(retrieval)
    }

    @Test
    fun returnsTheStableSearchReadinessContract() {
        Mockito.doReturn(
            SupportProgramSearchReadinessResult(
                searchState = SupportProgramSearchState.SEARCHABLE_WITH_SYNC_FAILURE,
                programCount = 17,
                indexReady = true,
                lastSuccessfulSyncAt = OffsetDateTime.parse("2026-09-05T09:00:00+09:00"),
                lastFailedSyncAt = OffsetDateTime.parse("2026-09-05T10:00:00+09:00"),
                sources = listOf(
                    SupportProgramSourceReadinessResult(
                        sourceCode = "BIZINFO",
                        sourceName = "기업마당",
                        searchState = SupportProgramSearchState.SEARCHABLE_WITH_SYNC_FAILURE,
                        programCount = 17,
                        indexReady = true,
                        lastSuccessfulSyncAt = OffsetDateTime.parse("2026-09-05T09:00:00+09:00"),
                        lastFailedSyncAt = OffsetDateTime.parse("2026-09-05T10:00:00+09:00"),
                    ),
                ),
            ),
        ).`when`(readinessService).get()

        mockMvc.perform(get(READINESS_PATH))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.searchState").value("SEARCHABLE_WITH_SYNC_FAILURE"))
            .andExpect(jsonPath("$.sources[0].sourceCode").value("BIZINFO"))
            .andExpect(jsonPath("$.sources[0].sourceName").value("기업마당"))
            .andExpect(jsonPath("$.sources[0].searchState").value("SEARCHABLE_WITH_SYNC_FAILURE"))
            .andExpect(jsonPath("$.sources[0].programCount").value(17))
            .andExpect(jsonPath("$.sources[0].lastFailedSyncAt").value("2026-09-05T10:00:00+09:00"))
            .andExpect(jsonPath("$.programCount").value(17))
            .andExpect(jsonPath("$.indexReady").value(true))
            .andExpect(jsonPath("$.lastSuccessfulSyncAt").value("2026-09-05T09:00:00+09:00"))
            .andExpect(jsonPath("$.lastFailedSyncAt").value("2026-09-05T10:00:00+09:00"))
    }

    @Test
    fun returnsTheCurrentProgramDetailsBySourceAndOriginalId() {
        Mockito.doReturn(catalogProgram()).`when`(supportProgramRepository)
            .findPresentBySourceAndProgramId("BIZINFO", "PBLN_TEST")

        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceCode", "BIZINFO")
                .queryParam("sourceProgramId", "PBLN_TEST"),
        )
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.id").value("PBLN_TEST"))
            .andExpect(jsonPath("$.sourceCode").value("BIZINFO"))
            .andExpect(jsonPath("$.title").value("서울 AI 지원사업"))
            .andExpect(jsonPath("$.matchedReasons").isEmpty())
            .andExpect(jsonPath("$.recommendationScore").value(nullValue()))
    }

    @Test
    fun returnsAStableNotFoundProblemForMissingOrInactiveProgramDetails() {
        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceCode", "BIZINFO")
                .queryParam("sourceProgramId", "PBLN_MISSING"),
        )
            .andExpect(status().isNotFound())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:support-program-not-found"))
            .andExpect(jsonPath("$.status").value(404))
            .andExpect(jsonPath("$.title").value("Support Program Not Found"))
            .andExpect(
                jsonPath("$.detail")
                    .value("The requested support program does not exist or is no longer available."),
            )
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_NOT_FOUND"))
            .andExpect(jsonPath("$.instance").value(DETAIL_PATH))
    }

    @Test
    fun validatesBothCompositeDetailIdentityParameters() {
        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceCode", " ")
                .queryParam("sourceProgramId", "PBLN_TEST"),
        )
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))

        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceCode", "other:source")
                .queryParam("sourceProgramId", "PBLN_TEST"),
        )
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))

        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceCode", "BIZINFO")
                .queryParam("sourceProgramId", " PBLN_TEST "),
        )
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
    }

    @Test
    fun returnsTheValidationProblemWhenACompositeDetailIdentityParameterIsMissing() {
        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceProgramId", "PBLN_TEST"),
        )
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:request-validation-failed"))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.errors[0].field").value("sourceCode"))
            .andExpect(jsonPath("$.errors[0].code").value("INVALID_VALUE"))
    }

    @Test
    fun rejectsDetailIdentityValuesThatExceedTheirPublicLimits() {
        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceCode", "S".repeat(65))
                .queryParam("sourceProgramId", "PBLN_TEST"),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))

        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceCode", "BIZINFO")
                .queryParam("sourceProgramId", "😀".repeat(256)),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
    }

    @Test
    fun acceptsDetailIdentitySourceProgramIdAtThe255UnicodeCodePointLimit() {
        val sourceProgramId = "😀".repeat(255)
        Mockito.doReturn(catalogProgram()).`when`(supportProgramRepository)
            .findPresentBySourceAndProgramId("BIZINFO", sourceProgramId)

        mockMvc.perform(
            get(DETAIL_PATH)
                .queryParam("sourceCode", "BIZINFO")
                .queryParam("sourceProgramId", sourceProgramId),
        )
            .andExpect(status().isOk())
    }

    @Test
    fun returnsAnOfficialSourceGroundedAnswerWithOnlyValidatedCitations() {
        Mockito.doReturn(
            SupportProgramEvidenceAnswerResult(
                answer = "공식 원문에 따르면 온라인으로 신청합니다.",
                answerStatus = SupportProgramEvidenceAnswerStatus.ANSWERED,
                citations = listOf(
                    SupportProgramEvidenceCitationResult(
                        excerpt = "신청 방법: 온라인 접수",
                        sourceUrl = "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_TEST",
                        chunkOrder = 2,
                    ),
                ),
            ),
        ).`when`(evidenceService).answer("BIZINFO", "PBLN_TEST", "신청 방법은?")

        mockMvc.perform(
            post(EVIDENCE_ANSWER_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {"sourceCode":"BIZINFO","sourceProgramId":"PBLN_TEST","question":"신청 방법은?"}
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.answer").value("공식 원문에 따르면 온라인으로 신청합니다."))
            .andExpect(jsonPath("$.answerStatus").value("ANSWERED"))
            .andExpect(jsonPath("$.citations[0].excerpt").value("신청 방법: 온라인 접수"))
            .andExpect(jsonPath("$.citations[0].chunkOrder").value(2))
    }

    @Test
    fun validatesEvidenceAnswerRequestAndMapsSupportedFailureCases() {
        mockMvc.perform(
            post(EVIDENCE_ANSWER_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"sourceCode":"BIZINFO","sourceProgramId":"PBLN_TEST","question":" "}"""),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))

        mockMvc.perform(
            post(EVIDENCE_ANSWER_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"sourceCode":"BIZINFO","sourceProgramId":" PBLN_TEST ","question":"질문"}"""),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))

        mockMvc.perform(
            post(EVIDENCE_ANSWER_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"sourceCode\":\"BIZINFO\",\"sourceProgramId\":\"PBLN_TEST\",\"question\":\"신청\\u0000방법\"}"),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))

        Mockito.doThrow(SupportProgramEvidenceNotSupportedException()).`when`(evidenceService)
            .answer("OTHER", "PBLN_TEST", "질문")
        mockMvc.perform(
            post(EVIDENCE_ANSWER_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"sourceCode":"OTHER","sourceProgramId":"PBLN_TEST","question":"질문"}"""),
        )
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_EVIDENCE_NOT_SUPPORTED"))

        Mockito.doThrow(SupportProgramEvidenceUnavailableException(IllegalStateException("private detail")))
            .`when`(evidenceService)
            .answer("BIZINFO", "PBLN_TEST", "잠시 후")
        mockMvc.perform(
            post(EVIDENCE_ANSWER_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"sourceCode":"BIZINFO","sourceProgramId":"PBLN_TEST","question":"잠시 후"}"""),
        )
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_EVIDENCE_UNAVAILABLE"))
            .andExpect(content().string(not(containsString("private detail"))))
    }

    @Test
    fun appliesTheUnicodeCodePointLimitToEvidenceSourceProgramId() {
        val maximumSourceProgramId = "😀".repeat(255)
        Mockito.doReturn(
            SupportProgramEvidenceAnswerResult(
                answer = "공식 원문에 근거한 답변입니다.",
                answerStatus = SupportProgramEvidenceAnswerStatus.INSUFFICIENT_EVIDENCE,
                citations = emptyList(),
            ),
        ).`when`(evidenceService).answer("BIZINFO", maximumSourceProgramId, "질문")

        mockMvc.perform(
            post(EVIDENCE_ANSWER_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """{"sourceCode":"BIZINFO","sourceProgramId":"$maximumSourceProgramId","question":"질문"}""",
                ),
        )
            .andExpect(status().isOk())

        val overLimitSourceProgramId = "😀".repeat(256)
        mockMvc.perform(
            post(EVIDENCE_ANSWER_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """{"sourceCode":"BIZINFO","sourceProgramId":"$overLimitSourceProgramId","question":"질문"}""",
                ),
        )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
    }

    @ParameterizedTest
    @MethodSource("aiServiceProblemCases")
    fun mapsEveryDirectAiClientFailureToAStableProblem(problemCase: ProblemCase) {
        Mockito.doReturn(listOf(catalogProgram())).`when`(retrieval)
            .retrieve("서울", listOf(catalogProgram()))
        Mockito.doReturn(listOf(catalogProgram()))
            .`when`(supportProgramRepository)
            .findSearchablePresent()
        ranking.failure = problemCase.exception

        assertProblem(
            mockMvc.perform(get(PATH).queryParam("query", "서울")),
            problemCase,
        )
    }

    @Test
    fun requiresASearchQueryParameter() {
        mockMvc.perform(get(PATH))
            .andExpect(status().isBadRequest())
    }

    @Test
    fun mapsIncompleteSemanticIndexToServiceUnavailable() {
        Mockito.doReturn(listOf(catalogProgram())).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doThrow(AiServiceCallException.unavailable(null)).`when`(retrieval)
            .retrieve("서울", listOf(catalogProgram()))

        mockMvc.perform(get(PATH).queryParam("query", "서울"))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("AI_SERVICE_UNAVAILABLE"))
    }

    @Test
    fun mapsLexicalFailureWithoutLeakingUpstreamDetailsOrReturningEmptySuccess() {
        Mockito.doReturn(listOf(catalogProgram())).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doThrow(ElasticsearchClientException("secret upstream URL and body")).`when`(retrieval)
            .retrieve("서울", listOf(catalogProgram()))
        mockMvc.perform(get(PATH).queryParam("query", "서울"))
            .andExpect(status().isServiceUnavailable())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_SEARCH_INDEX_UNAVAILABLE"))
            .andExpect(content().string(not(containsString("secret"))))
    }

    @Test
    fun rejectsAQueryLongerThanThePublicContractLimit() {
        mockMvc.perform(get(PATH).queryParam("query", "가".repeat(501)))
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.type").value("urn:govbiz:problem:request-validation-failed"))
            .andExpect(jsonPath("$.status").value(400))
            .andExpect(jsonPath("$.title").value("Request Validation Failed"))
            .andExpect(jsonPath("$.detail").value("One or more request fields are invalid."))
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.instance").value(PATH))
            .andExpect(jsonPath("$.errors[0].field").value("query"))
            .andExpect(jsonPath("$.errors[0].code").value("INVALID_VALUE"))
    }

    private fun assertProblem(result: ResultActions, problemCase: ProblemCase) {
        result
            .andExpect(status().`is`(problemCase.status))
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.type").value(problemCase.type))
            .andExpect(jsonPath("$.status").value(problemCase.status))
            .andExpect(jsonPath("$.title").value(problemCase.title))
            .andExpect(jsonPath("$.detail").value(problemCase.detail))
            .andExpect(jsonPath("$.code").value(problemCase.code))
            .andExpect(jsonPath("$.instance").value(PATH))
            .andExpect(content().string(not(containsString(PRIVATE_DETAIL))))
    }

    @Test
    fun postSearchNormalizesConditionsAndPreservesThePublicQueryWithoutEchoingCompanyData() {
        val programs = listOf(catalogProgram())
        val enriched = "사업화\n부산\n제조업\n시제품"
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(programs).`when`(retrieval).retrieve(enriched, programs)
        ranking.response = { it.map(CatalogSupportProgram::program) }

        mockMvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON).content(
            """{"query":"  사업화  ","companyConditions":{"region":" 부산 ","industry":" 제조업 ","establishedOn":"2024-02-29","supportPurpose":" 시제품 "}}""",
        ))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.query").value("사업화"))
            .andExpect(jsonPath("$.companyConditions").doesNotExist())
            .andExpect(jsonPath("$.programs[0].id").value("PBLN_TEST"))
        assertEquals(SupportProgramCompanyConditions("부산", "제조업", LocalDate.of(2024, 2, 29), "시제품"), ranking.conditions)
    }

    @ParameterizedTest
    @ValueSource(strings = ["{}", "{\"region\":\"  \",\"industry\":\"\",\"establishedOn\":\"\",\"supportPurpose\":null}", "null"])
    fun postSearchWithoutEffectiveConditionsUsesTheOriginalQuery(value: String) {
        val programs = listOf(catalogProgram())
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(programs).`when`(retrieval).retrieve("서울 AI", programs)
        mockMvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON).content(
            """{"query":"서울 AI","companyConditions":$value}""",
        )).andExpect(status().isOk())
        assertEquals(null, ranking.conditions)
    }

    @ParameterizedTest
    @ValueSource(strings = ["{}", "{\"query\":\" \"}", "{\"query\":\"AI\",\"companyConditions\":{\"establishedOn\":\"2025-02-29\"}}", "{\"query\":\"AI\",\"companyConditions\":{\"region\":\"서울\\n\"}}"])
    fun invalidPostSearchDoesNotCallTheCatalogOrAi(value: String) {
        mockMvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON).content(value))
            .andExpect(status().isBadRequest())
        Mockito.verifyNoInteractions(supportProgramRepository, retrieval)
    }

    @ParameterizedTest
    @ValueSource(booleans = [true, false])
    fun searchExposesOfficialApiEligibilitySeparatelyFromRecommendationReasons(matches: Boolean) {
        val programs = listOf(catalogProgram())
        Mockito.doReturn(programs).`when`(supportProgramRepository).findSearchablePresent()
        Mockito.doReturn(programs).`when`(retrieval).retrieve("서울 AI", programs)
        val assessment = SupportProgramEligibilityAssessment(
            if (matches) SupportProgramEligibilityStatus.MATCH else SupportProgramEligibilityStatus.UNKNOWN,
            if (matches) "공식 API 본문에서 확인했습니다." else "추가 기업 정보 확인이 필요합니다.",
            if (matches) listOf(SupportProgramEligibilityEvidence(SupportProgramEligibilityEvidenceField.TARGET_DESCRIPTION, "중소기업")) else emptyList(),
        )
        ranking.response = { candidates -> candidates.map { it.program.copy(
            recommendationScore = 85,
            matchedReasons = listOf("AI 지원사업"),
            eligibilityReview = SupportProgramEligibilityReview(
                if (matches) SupportProgramEligibilityReviewStatus.MATCH else SupportProgramEligibilityReviewStatus.REVIEW_REQUIRED,
                assessment,
                assessment,
            ),
        ) } }
        for (request in listOf(get(PATH).queryParam("query", "서울 AI"), post(PATH).contentType(MediaType.APPLICATION_JSON).content("""{"query":"서울 AI"}"""))) {
            val result = mockMvc.perform(request)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.programs[0].eligibilityReview.status").value(if (matches) "MATCH" else "REVIEW_REQUIRED"))
                .andExpect(jsonPath("$.programs[0].eligibilityReview.basis").value("OFFICIAL_API_TEXT"))
                .andExpect(jsonPath("$.programs[0].eligibilityReview.target.status").value(if (matches) "MATCH" else "UNKNOWN"))
                .andExpect(jsonPath("$.programs[0].eligibilityReview.region.explanation").value(assessment.explanation))
                .andExpect(jsonPath("$.programs[0].matchedReasons[0]").value("AI 지원사업"))
            if (matches) {
                result.andExpect(jsonPath("$.programs[0].eligibilityReview.target.evidence[0].field").value("TARGET_DESCRIPTION"))
                    .andExpect(jsonPath("$.programs[0].eligibilityReview.target.evidence[0].quote").value("중소기업"))
            } else result.andExpect(jsonPath("$.programs[0].eligibilityReview.target.evidence").isEmpty())
        }
    }

    @Test
    fun latestAndDetailDoNotClaimToHaveReviewedEligibility() {
        Mockito.doReturn(listOf(catalogProgram())).`when`(supportProgramRepository).findPublishedPresent()
        Mockito.doReturn(catalogProgram()).`when`(supportProgramRepository).findPresentBySourceAndProgramId("BIZINFO", "PBLN_TEST")
        mockMvc.perform(get(PATH).queryParam("query", ""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.programs[0].eligibilityReview").value(nullValue()))
        mockMvc.perform(get(DETAIL_PATH).queryParam("sourceCode", "BIZINFO").queryParam("sourceProgramId", "PBLN_TEST"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.eligibilityReview").value(nullValue()))
    }

    private fun catalogProgram() = CatalogSupportProgram(
        program = SupportProgram(
            id = "PBLN_TEST",
            sourceCode = "BIZINFO",
            title = "서울 AI 지원사업",
            organization = "수행기관",
            summary = "AI 기술 지원",
            categories = listOf("AI"),
            regions = listOf("서울"),
            targetDescription = "중소기업",
            applicationPeriod = "상시 접수",
            applicationStartDate = null,
            applicationEndDate = null,
            status = SupportProgramStatus.OPEN,
            sourceName = "기업마당",
            sourceUrl = "https://www.bizinfo.go.kr/detail?id=PBLN_TEST",
            matchedReasons = emptyList(),
            recommendationScore = null,
        ),
        sortTimestamp = "2026-08-21 10:00:00",
    )

    private class StubSupportProgramRankingFacade : SupportProgramRankingFacade {
        var response: (List<CatalogSupportProgram>) -> List<SupportProgram> = { emptyList() }
        var failure: RuntimeException? = null
        var conditions: SupportProgramCompanyConditions? = null

        override fun rank(
            query: String,
            candidates: List<CatalogSupportProgram>,
            limit: Int,
            companyConditions: SupportProgramCompanyConditions?,
            referenceDate: LocalDate?,
        ): List<SupportProgram> {
            failure?.let { throw it }
            conditions = companyConditions
            return response(candidates)
        }
    }

    private companion object {
        const val PATH = "/api/v1/support-programs/search"
        const val READINESS_PATH = "/api/v1/support-programs/readiness"
        const val DETAIL_PATH = "/api/v1/support-programs/detail"
        const val EVIDENCE_ANSWER_PATH = "/api/v1/support-programs/detail/answers"
        const val PRIVATE_DETAIL = "private upstream detail"

        @JvmStatic
        fun aiServiceProblemCases(): Stream<ProblemCase> =
            Stream.of(
                ProblemCase(
                    AiServiceCallException.upstreamError(
                        PRIVATE_DETAIL,
                        IllegalStateException(PRIVATE_DETAIL),
                    ),
                    502,
                    "urn:govbiz:problem:ai-service-upstream-error",
                    "AI Service Upstream Error",
                    "AI Service returned an unexpected HTTP status.",
                    "AI_SERVICE_UPSTREAM_ERROR",
                ),
                ProblemCase(
                    AiServiceCallException.invalidResponse(
                        PRIVATE_DETAIL,
                        IllegalArgumentException(PRIVATE_DETAIL),
                    ),
                    502,
                    "urn:govbiz:problem:ai-service-invalid-response",
                    "AI Service Invalid Response",
                    "AI Service returned an invalid response.",
                    "AI_SERVICE_INVALID_RESPONSE",
                ),
                ProblemCase(
                    AiServiceCallException.unavailable(
                        IllegalStateException(PRIVATE_DETAIL),
                    ),
                    503,
                    "urn:govbiz:problem:ai-service-unavailable",
                    "AI Service Unavailable",
                    "AI Service is currently unavailable.",
                    "AI_SERVICE_UNAVAILABLE",
                ),
                ProblemCase(
                    AiServiceCallException.timeout(
                        IllegalStateException(PRIVATE_DETAIL),
                    ),
                    504,
                    "urn:govbiz:problem:ai-service-timeout",
                    "AI Service Gateway Timeout",
                    "AI Service did not respond within the configured timeout.",
                    "AI_SERVICE_TIMEOUT",
                ),
            )
    }

    data class ProblemCase(
        val exception: RuntimeException,
        val status: Int,
        val type: String,
        val title: String,
        val detail: String,
        val code: String,
    )
}
