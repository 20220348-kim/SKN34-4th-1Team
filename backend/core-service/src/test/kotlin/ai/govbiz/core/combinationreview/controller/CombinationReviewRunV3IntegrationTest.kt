package ai.govbiz.core.combinationreview.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.combinationreview.client.AiCombinationReviewClient
import ai.govbiz.core.combinationreview.client.dto.*
import ai.govbiz.core.combinationreview.domain.ReviewRunStatus
import ai.govbiz.core.combinationreview.repository.CombinationReviewRunRepository
import ai.govbiz.core.combinationreview.service.CombinationReviewOutboxScheduler
import ai.govbiz.core.combinationreview.service.CombinationReviewRunService
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import jakarta.servlet.http.Cookie
import java.time.LocalDateTime
import java.util.UUID
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.ResultActions
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import tools.jackson.databind.ObjectMapper

/** `app.combination-review.contract-version=v3`로 새 실행이 세 질문 계약을 쓰는지 실제 MySQL 8.4까지 확인한다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1", "app.ai-service.connect-timeout=10ms", "app.ai-service.read-timeout=10ms",
    "app.combination-review.queue.enabled=true", "spring.rabbitmq.listener.simple.auto-startup=false",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false", "app.account.cookie-secure=false",
    "app.combination-review.contract-version=v3",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class CombinationReviewRunV3IntegrationTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var json: ObjectMapper
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var runs: CombinationReviewRunRepository
    @Autowired private lateinit var service: CombinationReviewRunService
    @MockitoBean private lateinit var publisher: CombinationReviewOutboxScheduler
    @MockitoBean private lateinit var source: BizInfoAttachmentClient
    @MockitoBean private lateinit var ai: AiCombinationReviewClient
    private var ownerId = 0L
    private lateinit var owner: Cookie
    private lateinit var answer: AiCombinationReviewV3Payload
    private val sent = mutableListOf<AiCombinationReviewV3Request>()
    private val placeholder = AiCombinationReviewV3Request("", emptyList(), AiReviewRelationRequest("", ""), "", "", emptyList(), emptyList())

    @BeforeEach
    fun prepare() {
        jdbc.update("DELETE FROM combination_review")
        sent.clear()
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@example.com", "test-hash", LocalDateTime.now()))
        val issued = sessions.issue(account.id, false)
        accounts.createSession(account.id, issued.session)
        ownerId = account.id
        owner = Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
        answer = json.readValue(resource("contract-v3-response.json"), AiCombinationReviewV3Payload::class.java)
        `when`(source.collect("BIZINFO", GENERAL)).thenReturn(fetched(resource("general.hwpx"), "general.hwpx"))
        `when`(source.collect("BIZINFO", DEEP)).thenReturn(fetched(resource("deeptech.hwpx"), "deeptech.hwpx"))
        `when`(ai.configuration(AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION))
            .thenReturn(AiReviewConfigurationPayload(answer.contractVersion, answer.model, answer.promptVersion))
        `when`(ai.analyzeV3(any(AiCombinationReviewV3Request::class.java) ?: placeholder)).thenAnswer {
            val request = it.getArgument<AiCombinationReviewV3Request>(0)
            sent.add(request)
            groundedIn(answer, request)
        }
    }

    @Test
    fun newRunSendsStatusesAndRelationAndReturnsOnlyTheThreeAnswers() {
        val reviewId = createReview()

        val runId = id(start(reviewId).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("SUCCEEDED"))
            .andExpect(jsonPath("$.configuration.contractVersion").value(AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION))
            .andExpect(jsonPath("$.input.relation.sameProject").value("YES"))
            .andExpect(jsonPath("$.input.relation.sameCost").value("NO"))
            .andExpect(jsonPath("$.input.programs[0].participation.selected").value("YES"))
            .andExpect(jsonPath("$.analysis.pairs[0].stages.length()").value(0))
            .andExpect(jsonPath("$.analysis.pairs[0].answers.length()").value(3))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[0].question").value("APPLY"))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[0].verdict").value("ALLOWED"))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[0].citations[0].evidenceId").value("E0"))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[1].verdict").value("ASK_INSTITUTION"))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[1].institutionQuestion").value(answer.pairs[0].answers[1].institutionQuestion))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[2].verdict").value("CONDITIONAL"))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[2].conditions[0].result").value("NOT_ALLOWED"))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[2].conditions[1].citations.length()").value(0))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[2].consequences[0].moment").value("SELECTION"))
            .andExpect(jsonPath("$.analysis.pairs[0].answers[2].consequences[1].action").value(answer.pairs[0].answers[2].consequences[1].action)))

        val request = sent.single()
        assertEquals(AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION, request.contractVersion)
        assertEquals(listOf("ACTIVE", "APPLIED"), request.programs.map { it.status })
        assertEquals(listOf(GENERAL, DEEP), request.programs.map { it.sourceProgramId })
        assertEquals(AiReviewRelationRequest("YES", "NO"), request.relation)
        assertEquals("E0", request.evidence.first().id)
        assertTrue(request.evidence.any { it.programIndex == 1 })
        val stored = requireNotNull(runs.findOwned(ownerId, reviewId, runId))
        assertEquals(AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION, stored.configuration!!.contractVersion)
        assertTrue(stored.analysis!!.pairs.single().stages.isEmpty())
        verify(ai, never()).configuration(null)
        verify(ai, never()).analyze(any(AiCombinationReviewRequest::class.java) ?: V2_PLACEHOLDER)
    }

    @Test
    fun verdictRuleViolationFailsAsAnalysisInvalidWithoutStoringAnswers() {
        val pair = answer.pairs.single()
        answer = answer.copy(pairs = listOf(pair.copy(answers = listOf(pair.answers[0].copy(citations = emptyList())) + pair.answers.drop(1))))
        val reviewId = createReview()

        val runId = id(start(reviewId).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("FAILED"))
            .andExpect(jsonPath("$.failureCode").value("ANALYSIS_INVALID"))
            .andExpect(jsonPath("$.configuration.contractVersion").value(AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION))
            .andExpect(jsonPath("$.analysis").isEmpty()))

        val stored = requireNotNull(runs.findOwned(ownerId, reviewId, runId))
        assertEquals(ReviewRunStatus.FAILED, stored.status)
        assertNull(stored.analysis)
        assertEquals(1, sent.size)
    }

    private fun createReview(): Long {
        val body = """{"title":"세 질문 검토","programs":[
            {"sourceCode":"BIZINFO","sourceProgramId":"$GENERAL","participation":{"applicationSubmitted":"YES","selected":"YES","commitmentSubmitted":"NO"}},
            {"sourceCode":"BIZINFO","sourceProgramId":"$DEEP","participation":{"applicationSubmitted":"YES"}}
        ],"relation":{"sameProject":"YES","sameCost":"NO"}}"""
        val response = mvc.perform(post("/api/v1/combination-reviews").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isCreated()).andReturn().response
        return json.readTree(response.contentAsString).path("id").asLong()
    }

    /** 큐 소비를 직접 구동하고 공개 GET으로 저장 결과를 읽는다. */
    private fun start(reviewId: Long): ResultActions {
        val path = "/api/v1/combination-reviews/$reviewId/runs"
        val body = json.writeValueAsString(mapOf("requestKey" to UUID.randomUUID().toString(), "expectedRevision" to 1, "additionalFacts" to ""))
        val submitted = mvc.perform(post(path).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isAccepted())
        val runId = id(submitted)
        service.executeQueued(runId)
        return mvc.perform(get("$path/$runId").cookie(owner))
    }

    /**
     * 공유 고정 응답의 인용은 고정 요청 원문 기준이다. 실제로 파싱한 공고 원문(E0)의 조각으로 바꿔
     * 같은 판정·조건·조치 모양을 유지한 채 Core의 원문 대조 검증을 통과시킨다. 빈 인용 목록은 그대로 둔다.
     */
    private fun groundedIn(payload: AiCombinationReviewV3Payload, request: AiCombinationReviewV3Request): AiCombinationReviewV3Payload {
        val block = request.evidence.first()
        val quote = AiReviewCitationPayload(block.id, block.text.take(60))
        fun List<AiReviewCitationPayload>.grounded() = map { quote }
        return payload.copy(pairs = payload.pairs.map { pair ->
            pair.copy(answers = pair.answers.map { answer ->
                answer.copy(
                    citations = answer.citations.grounded(),
                    conditions = answer.conditions.map { it.copy(citations = it.citations.grounded()) },
                    consequences = answer.consequences.map { it.copy(citations = it.citations.grounded()) },
                )
            })
        })
    }

    private fun id(result: ResultActions) = json.readTree(result.andReturn().response.contentAsString).path("id").asLong()
    private fun fetched(bytes: ByteArray, name: String) = SupportProgramAttachments(
        "공식 공고",
        listOf(SupportProgramAttachment("https://www.mss.go.kr/common/board/Download.do?bcIdx=1&cbIdx=310&streFileNm=$name", name, "HWPX", bytes)),
        listOf("기관 해석 미확인"),
        "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=$GENERAL",
    )
    private fun resource(name: String) = requireNotNull(javaClass.getResourceAsStream("/combinationreview/$name")).use { it.readBytes() }

    private companion object {
        const val ORIGIN = "http://localhost:5173"
        const val GENERAL = "PBLN_000000000117820"
        const val DEEP = "PBLN_000000000117172"
        val V2_PLACEHOLDER = AiCombinationReviewRequest("", emptyList(), "", "", emptyList(), emptyList())
    }
}
