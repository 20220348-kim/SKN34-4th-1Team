package ai.govbiz.core.combinationreview.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.combinationreview.service.CombinationReviewRunService
import ai.govbiz.core.combinationreview.service.CombinationReviewOutboxScheduler
import org.springframework.test.context.bean.override.mockito.MockitoBean
import jakarta.servlet.http.Cookie
import java.time.LocalDateTime
import java.util.UUID
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.web.client.RestClient
import tools.jackson.databind.ObjectMapper

/** Explicit opt-in: real official download + Core HTTP + MySQL + AI HTTP, ScriptedModel only. */
@Tag("live-source")
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false", "app.account.cookie-secure=false",
    "app.combination-review.queue.enabled=true", "spring.rabbitmq.listener.simple.auto-startup=false",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class CombinationReviewLiveFlowIntegrationTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var json: ObjectMapper
    @Autowired private lateinit var service: CombinationReviewRunService
    @MockitoBean private lateinit var publisher: CombinationReviewOutboxScheduler

    @Test
    fun runsAutomaticOfficialSourcesAcrossServicesAndPersistsReplayWithoutAnotherModelCall() {
        val aiUrl = requireNotNull(System.getenv("GOVBIZ_TEST_AI_URL"))
        val probe = RestClient.create(aiUrl)
        val before = json.readTree(probe.get().uri("/__test__/calls").retrieve().body(String::class.java))
        assertEquals(0, before.path("scriptedCalls").asInt())
        assertEquals(0, before.path("paidCalls").asInt())
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@example.com", "test-hash", LocalDateTime.now()))
        val issued = sessions.issue(account.id, false); accounts.createSession(account.id, issued.session)
        val cookie = Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
        val created = mvc.perform(post("/api/v1/combination-reviews").cookie(cookie).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content("""{"title":"무료 통합 검증","programs":[{"sourceCode":"BIZINFO","sourceProgramId":"PBLN_000000000117820"},{"sourceCode":"BIZINFO","sourceProgramId":"PBLN_000000000117172"}]}"""))
            .andExpect(status().isCreated()).andReturn().response
        val reviewId = json.readTree(created.contentAsString).path("id").asLong()
        val body = """{"expectedRevision":1,"requestKey":"${UUID.randomUUID()}","additionalFacts":"계약 검증용 가상 입력"}"""
        val path = "/api/v1/combination-reviews/$reviewId/runs"
        val accepted = mvc.perform(post(path).cookie(cookie).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isAccepted()).andExpect(jsonPath("$.status").value("QUEUED")).andReturn().response
        val acceptedId = json.readTree(accepted.contentAsString).path("id").asLong()
        service.executeQueued(acceptedId)
        val result = mvc.perform(get("$path/$acceptedId").cookie(cookie))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("SUCCEEDED"))
            .andExpect(jsonPath("$.configuration.model").value("test-model"))
            .andExpect(jsonPath("$.evidence.documents.length()").value(2)).andReturn().response
        val run = json.readTree(result.contentAsString)
        val runId = run.path("id").asLong()
        mvc.perform(post(path).cookie(cookie).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(runId))
        mvc.perform(get("$path/$runId").cookie(cookie)).andExpect(status().isOk()).andExpect(content().json(result.contentAsString))
        mvc.perform(get("$path/$runId/sources/0").cookie(cookie)).andExpect(status().isOk())
        val after = json.readTree(probe.get().uri("/__test__/calls").retrieve().body(String::class.java))
        assertEquals(1, after.path("scriptedCalls").asInt())
        assertEquals(0, after.path("paidCalls").asInt())
        println("FREE_FLOW status=SUCCEEDED programs=2 documents=${run.path("evidence").path("documents").size()} blocks=${run.path("evidence").path("blocks").size()} scriptedCalls=1 paidCalls=0 qualityMeasured=false")
    }

    companion object {
        const val ORIGIN = "http://localhost:5173"
        @JvmStatic @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("app.ai-service.base-url") { requireNotNull(System.getenv("GOVBIZ_TEST_AI_URL")) { "Start the isolated contract agent, not a real model service" } }
        }
    }
}
