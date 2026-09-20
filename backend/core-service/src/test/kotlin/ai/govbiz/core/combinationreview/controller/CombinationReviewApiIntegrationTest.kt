package ai.govbiz.core.combinationreview.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import jakarta.servlet.http.Cookie
import java.time.LocalDateTime
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.hamcrest.Matchers.endsWith
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.ResultActions
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import tools.jackson.databind.ObjectMapper

/** 실제 세션 검증부터 MySQL 8.4 저장까지 연결한다. AI 호출·브라우저 화면 검증은 포함하지 않는다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.ai-service.connect-timeout=10ms",
    "app.ai-service.read-timeout=10ms",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
    "app.account.cookie-secure=false",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class CombinationReviewApiIntegrationTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var json: ObjectMapper
    private lateinit var owner: Cookie
    private lateinit var other: Cookie
    private var ownerId = 0L
    private var otherId = 0L

    @BeforeEach
    fun prepareSessions() {
        jdbc.update("DELETE FROM combination_review")
        val first = newSession()
        ownerId = first.first
        owner = first.second
        val second = newSession()
        otherId = second.first
        other = second.second
    }

    @Test
    fun disabledQueueRejectsNewAnalysisWithoutCreatingARun() {
        val id = create()
        write(post("$BASE/$id/runs"), """{"expectedRevision":1,"requestKey":"${UUID.randomUUID()}","additionalFacts":""}""")
            .andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("RUN_QUEUE_UNAVAILABLE"))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_run WHERE review_id = ?", Int::class.java, id))
        mvc.perform(get("$BASE/$id").cookie(owner)).andExpect(status().isOk())
    }

    @Test
    fun createsAndReadsIndependentFactsWithServerOwnershipAndNoStore() {
        val response = mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload().dropLast(1) + ",\"ownerAccountId\":$otherId}"))
            .andExpect(status().isCreated())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.ownerAccountId").doesNotExist())
            .andExpect(jsonPath("$.inputRevision").value(1))
            .andExpect(jsonPath("$.programs[0].participation.selected").value("YES"))
            .andExpect(jsonPath("$.programs[0].participation.commitmentSubmitted").value("UNKNOWN"))
            .andExpect(jsonPath("$.programs[0].participation.fundingReceived").value("NO"))
            .andExpect(jsonPath("$.programs[1].participation.applicationSubmitted").value("UNKNOWN"))
            .andExpect(jsonPath("$.createdAt", endsWith("+09:00")))
            .andReturn().response
        val id = json.readTree(response.contentAsString).path("id").asLong()
        assertEquals("$BASE/$id", response.getHeader(HttpHeaders.LOCATION))
        assertEquals(ownerId, jdbc.queryForObject("SELECT owner_account_id FROM combination_review WHERE id = ?", Long::class.java, id))
        mvc.perform(get("$BASE/$id").cookie(owner))
            .andExpect(status().isOk()).andExpect(content().json(response.contentAsString))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
    }

    @Test
    fun replacesAllInputsAndRejectsAStaleRevisionWithoutChangingTheStoredInput() {
        val id = create()
        write(put("$BASE/$id/inputs"), replacement(title = "수정된 검토"))
            .andExpect(status().isNoContent()).andExpect(content().string(""))
        write(put("$BASE/$id/inputs"), replacement(title = "오래된 화면"))
            .andExpect(status().isConflict())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("COMBINATION_REVIEW_REVISION_CONFLICT"))
        mvc.perform(get("$BASE/$id").cookie(owner))
            .andExpect(status().isOk()).andExpect(jsonPath("$.title").value("수정된 검토"))
            .andExpect(jsonPath("$.inputRevision").value(2))
        write(put("$BASE/$id/inputs"), replacement(revision = "2"))
            .andExpect(status().isNoContent())
    }

    @Test
    fun deletesOnlyTheOwnedReviewAndItsPrograms() {
        val id = create()
        mvc.perform(delete("$BASE/$id").cookie(other).header(HttpHeaders.ORIGIN, ORIGIN))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("COMBINATION_REVIEW_NOT_FOUND"))
        assertEquals(1, countReviews())

        mvc.perform(delete("$BASE/$id").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN))
            .andExpect(status().isNoContent())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(content().string(""))
        assertEquals(0, countReviews())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_program WHERE review_id = ?", Int::class.java, id))
        mvc.perform(get("$BASE/$id").cookie(owner)).andExpect(status().isNotFound())
    }

    @Test
    fun returnsTheSameNotFoundContractForMissingAndOtherOwnersEvenForAnAdmin() {
        val id = create()
        jdbc.update("UPDATE account SET role = 'ADMIN' WHERE id = ?", otherId)
        for (reviewId in listOf(id, Long.MAX_VALUE)) {
            mvc.perform(get("$BASE/$reviewId").cookie(other))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("COMBINATION_REVIEW_NOT_FOUND"))
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            write(put("$BASE/$reviewId/inputs"), replacement(revision = "999"), other)
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("COMBINATION_REVIEW_NOT_FOUND"))
        }
        assertEquals(1L, jdbc.queryForObject("SELECT input_revision FROM combination_review WHERE id = ?", Long::class.java, id))
    }

    @Test
    fun paginatesOnlyOwnedSummariesInCreationOrderAcrossAnInsertAndAnEdit() {
        val oldest = create()
        create(other)
        val middle = create()
        val newest = create()
        mvc.perform(get(BASE).cookie(owner).param("size", "2"))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.items.length()").value(2))
            .andExpect(jsonPath("$.items[0].id").value(newest))
            .andExpect(jsonPath("$.items[1].id").value(middle))
            .andExpect(jsonPath("$.nextBeforeId").value(middle))
            .andExpect(jsonPath("$.items[0].programs").doesNotExist())
            .andExpect(jsonPath("$.items[0].ownerAccountId").doesNotExist())
        create()
        write(put("$BASE/$oldest/inputs"), replacement()).andExpect(status().isNoContent())
        mvc.perform(get(BASE).cookie(owner).param("size", "2").param("beforeId", middle.toString()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].id").value(oldest))
            .andExpect(jsonPath("$.items[0].inputRevision").value(2))
            .andExpect(jsonPath("$.nextBeforeId").isEmpty())
        mvc.perform(get(BASE).cookie(other).param("beforeId", "1"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty())
            .andExpect(jsonPath("$.nextBeforeId").isEmpty())
    }

    @Test
    fun defaultsToTwentyAndAllowsFiftySummaries() {
        repeat(21) { create() }
        mvc.perform(get(BASE).cookie(owner)).andExpect(status().isOk())
            .andExpect(jsonPath("$.items.length()").value(20)).andExpect(jsonPath("$.nextBeforeId").isNumber())
        mvc.perform(get(BASE).cookie(owner).param("size", "50")).andExpect(status().isOk())
            .andExpect(jsonPath("$.items.length()").value(21)).andExpect(jsonPath("$.nextBeforeId").isEmpty())
    }

    @Test
    fun readsDoNotCreateReviews() {
        mvc.perform(get(BASE).cookie(owner)).andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty())
        mvc.perform(get("$BASE/123").cookie(owner)).andExpect(status().isNotFound())
        assertEquals(0, countReviews())
    }

    @ParameterizedTest
    @ValueSource(strings = ["absent", "invalid", "expired", "logged-out", "deleted", "suspended"])
    fun requiresAnActiveSessionForEveryEndpoint(state: String) {
        val id = create()
        var cookie: Cookie? = owner
        when (state) {
            "absent" -> cookie = null
            "invalid" -> cookie = Cookie(SessionCookieHelper.COOKIE_NAME, "invalid")
            "expired" -> jdbc.update("UPDATE account_session SET expires_at = '2000-01-01' WHERE account_id = ?", ownerId)
            "logged-out" -> sessions.logOut(owner.value)
            "deleted" -> jdbc.update("UPDATE account SET deleted_at = NOW(6) WHERE id = ?", ownerId)
            "suspended" -> jdbc.update("UPDATE account SET suspended_at = NOW(6) WHERE id = ?", ownerId)
        }
        val requests = listOf(get(BASE), get("$BASE/$id"), post(BASE).content(payload()), put("$BASE/$id/inputs").content(replacement()), delete("$BASE/$id"))
        for (request in requests) {
            if (cookie != null) request.cookie(cookie)
            mvc.perform(request.header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().`is`(if (state == "suspended") 403 else 401))
                .andExpect(jsonPath("$.code").value(if (state == "suspended") "ACCOUNT_SUSPENDED" else "AUTHENTICATION_REQUIRED"))
        }
        assertEquals(1, countReviews())
        assertEquals(1L, jdbc.queryForObject("SELECT input_revision FROM combination_review WHERE id = ?", Long::class.java, id))
    }

    @Test
    fun rejectsInvalidBodiesBeforeWritingAndKeepsDomainLimits() {
        val invalidBodies = listOf(
            "{}", "{", payload(title = ""), payload(title = " 공백"), payload(title = "x".repeat(201)),
            payload(title = "줄\n바꿈"), payload(programs = "[]"), payload(programs = "[$PROGRAM]"),
            payload(programs = "[$PROGRAM,$PROGRAM]"), payload(programs = "[$PROGRAM,null]"),
            payload(programs = "[$PROGRAM,$SECOND,{\"sourceCode\":\"MSIT\",\"sourceProgramId\":\"3\"}]"),
            payload(programs = "[$PROGRAM,$PROGRAM,$PROGRAM,$PROGRAM]"),
            payload().replace("BIZINFO", "bizinfo"), payload().replace("공고-A", " 공고-A"),
            payload().replace("공고-A", "x".repeat(256)), payload().replace("일반형", ""),
            payload().replace("일반형", "x".repeat(256)), payload().replace("\"YES\"", "\"MAYBE\""),
            payload().replace("\"YES\"", "1"), payload().replace("\"YES\"", "null"),
            payload().replace("\"NOT_STARTED\"", "\"YES\""),
            """{"title":"검토","programs":null}""",
            """{"title":null,"programs":[$PROGRAM,$SECOND]}""",
            """{"title":"검토","programs":[{"sourceCode":"BIZINFO","sourceProgramId":"공고-A","participation":null},$SECOND]}""",
        )
        val id = create()
        for (body in invalidBodies) {
            write(post(BASE), body).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            // PUT과 POST는 같은 Domain 입력 경계를 사용한다.
            val update = if (body.endsWith("}")) body.dropLast(1) + ",\"expectedRevision\":1}" else body
            write(put("$BASE/$id/inputs"), update).andExpect(status().isBadRequest())
        }
        assertEquals(1, countReviews())
        assertEquals(1L, jdbc.queryForObject("SELECT input_revision FROM combination_review WHERE id = ?", Long::class.java, id))
    }

    @Test
    fun acceptsTwoDistinctSubProgramsAndUnicodeCodePointBoundary() {
        val programs = """[$PROGRAM,{"sourceCode":"BIZINFO","sourceProgramId":"공고-A","subProgramId":"딥테크"}]"""
        write(post(BASE), payload(title = "🚀".repeat(200), programs = programs))
            .andExpect(status().isCreated()).andExpect(jsonPath("$.programs.length()").value(2))
    }

    @ParameterizedTest
    @ValueSource(strings = ["0", "-1", "9223372036854775807", "null", "1.5", "\"1\"", "true"])
    fun rejectsInvalidRevisions(revision: String) {
        val id = create()
        write(put("$BASE/$id/inputs"), replacement(revision = revision)).andExpect(status().isBadRequest())
        write(put("$BASE/$id/inputs"), payload()).andExpect(status().isBadRequest())
    }

    @Test
    fun rejectsInvalidPathsAndPagination() {
        for (id in listOf("0", "-1", "abc", "9223372036854775808")) {
            mvc.perform(get("$BASE/$id").cookie(owner)).andExpect(status().isBadRequest())
            write(put("$BASE/$id/inputs"), replacement()).andExpect(status().isBadRequest())
            mvc.perform(delete("$BASE/$id").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)).andExpect(status().isBadRequest())
        }
        for ((name, value) in listOf("size" to "0", "size" to "51", "size" to "abc", "beforeId" to "0", "beforeId" to "-1", "beforeId" to "abc")) {
            mvc.perform(get(BASE).cookie(owner).param(name, value)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
        }
    }

    @Test
    fun keepsOriginProtectionAndAllowsPutPreflightFromTheConfiguredOrigin() {
        val id = create()
        val path = "$BASE/$id/inputs"
        mvc.perform(options(path).header(HttpHeaders.ORIGIN, ORIGIN)
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "PUT")
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, "content-type"))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, ORIGIN))
            .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS, "true"))
        mvc.perform(options(path).header(HttpHeaders.ORIGIN, "https://evil.example")
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "PUT")).andExpect(status().isForbidden())
        for (request in listOf(post(BASE).content(payload()), put(path).content(replacement()))) {
            mvc.perform(request.cookie(owner).contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("SESSION_ORIGIN_REJECTED"))
        }
        write(put(path), replacement(), origin = "https://evil.example").andExpect(status().isForbidden())
        mvc.perform(put(path).cookie(owner).contentType(MediaType.APPLICATION_JSON).content(replacement())
            .header(HttpHeaders.REFERER, "$ORIGIN/app/combination-reviews/$id"))
            .andExpect(status().isNoContent())
        assertEquals(1, countReviews())
        assertEquals(2L, jdbc.queryForObject("SELECT input_revision FROM combination_review WHERE id = ?", Long::class.java, id))
    }

    @Test
    fun concurrentPutsAtTheSameRevisionHaveExactlyOneWinner() {
        val id = create()
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val futures = (1..2).map { index -> executor.submit(Callable {
                assertTrue(start.await(10, TimeUnit.SECONDS))
                write(put("$BASE/$id/inputs"), replacement(title = "수정 $index")).andReturn().response.status
            }) }
            start.countDown()
            assertEquals(listOf(204, 409), futures.map { it.get(20, TimeUnit.SECONDS) }.sorted())
            assertEquals(2L, jdbc.queryForObject("SELECT input_revision FROM combination_review WHERE id = ?", Long::class.java, id))
        } finally {
            executor.shutdownNow()
        }
    }

    private fun newSession(): Pair<Long, Cookie> {
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@example.com", "test-hash", LocalDateTime.now()))
        val issued = sessions.issue(account.id, false)
        accounts.createSession(account.id, issued.session)
        return account.id to Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
    }

    private fun create(session: Cookie = owner): Long {
        val response = write(post(BASE), payload(), session).andExpect(status().isCreated()).andReturn().response
        return json.readTree(response.contentAsString).path("id").asLong()
    }

    private fun write(request: MockHttpServletRequestBuilder, body: String, session: Cookie = owner, origin: String = ORIGIN): ResultActions =
        mvc.perform(request.cookie(session).header(HttpHeaders.ORIGIN, origin).contentType(MediaType.APPLICATION_JSON).content(body))

    private fun payload(title: String = "중복 지원 검토", programs: String = "[$PROGRAM,$SECOND]"): String =
        "{\"title\":${json.writeValueAsString(title)},\"programs\":$programs}"

    private fun replacement(revision: String = "1", title: String = "수정 검토"): String =
        payload(title).dropLast(1) + ",\"expectedRevision\":$revision}"

    private fun countReviews(): Int = requireNotNull(jdbc.queryForObject("SELECT COUNT(*) FROM combination_review", Int::class.java))

    private companion object {
        const val BASE = "/api/v1/combination-reviews"
        const val ORIGIN = "http://localhost:5173"
        const val PROGRAM = """{"sourceCode":"BIZINFO","sourceProgramId":"공고-A","subProgramId":"일반형","participation":{"selected":"YES","fundingReceived":"NO","executionStatus":"NOT_STARTED"}}"""
        const val SECOND = """{"sourceCode":"KSTARTUP","sourceProgramId":"공고-B"}"""
    }
}
