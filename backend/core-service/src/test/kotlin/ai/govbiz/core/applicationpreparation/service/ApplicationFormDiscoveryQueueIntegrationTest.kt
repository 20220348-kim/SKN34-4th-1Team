package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.admin.service.QueueOperationsService
import ai.govbiz.core.applicationpreparation.client.ApplicationFormDiscoveryQueueClient
import ai.govbiz.core.applicationpreparation.config.ApplicationFormDiscoveryRabbitConfig
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryResult
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMapSnapshot
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormDiscoveryJobRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import jakarta.servlet.http.Cookie
import java.time.Duration
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.UUID
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.*
import org.springframework.amqp.core.Binding
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory
import org.springframework.amqp.rabbit.core.RabbitAdmin
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.amqp.rabbit.listener.RabbitListenerEndpointRegistry
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.http.MediaType
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers

/** MySQL 8.4와 RabbitMQ는 실제 실행한다. 외부 수집·AI 분석만 대체하며 유료 API를 사용하지 않는다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789", "app.account.cookie-secure=false",
    "app.bizinfo.sync.enabled=false", "app.kstartup.sync.enabled=false", "app.msit.sync.enabled=false",
    "app.cntrade-notice.sync.enabled=false", "app.support-program-index.enabled=false",
    "app.application-form-discovery.queue.enabled=true", "app.daily-report.queue.enabled=false",
    "app.combination-review.queue.enabled=false", "spring.rabbitmq.listener.simple.auto-startup=false",
    "app.ai-service.base-url=http://127.0.0.1:1",
])
@Import(MySqlTestContainerConfig::class)
@AutoConfigureMockMvc
@Testcontainers
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ApplicationFormDiscoveryQueueIntegrationTest {
    @Autowired private lateinit var jobs: ApplicationFormDiscoveryJobRepository
    @Autowired private lateinit var service: ApplicationFormDiscoveryJobService
    @Autowired private lateinit var forms: ApplicationFormService
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var client: ApplicationFormDiscoveryQueueClient
    @Autowired private lateinit var admin: RabbitAdmin
    @Autowired private lateinit var rabbitTemplate: RabbitTemplate
    @Autowired private lateinit var registry: RabbitListenerEndpointRegistry
    @Autowired private lateinit var factory: CachingConnectionFactory
    @Autowired private lateinit var operations: QueueOperationsService
    @Autowired private lateinit var mvc: MockMvc
    @MockitoBean private lateinit var backgroundPublisher: ApplicationFormDiscoveryOutboxScheduler
    @MockitoBean private lateinit var discovery: ApplicationFormDiscoveryService
    private val listener get() = requireNotNull(registry.getListenerContainer("applicationFormDiscoveryRun"))
    private val publisher get() = ApplicationFormDiscoveryOutboxScheduler(jobs, client)
    private lateinit var account: Account
    private val form get() = forms.requireVersion("bizinfo-pbln-000000000118979-innovation-voucher-2026-v1")
    private val result get() = ApplicationFormDiscoveryResult(listOf(form), listOf("한글 & 특수문자 🧪 원문 대조"), false)

    @BeforeEach
    fun prepare() {
        listener.stop()
        admin.initialize()
        admin.purgeQueue(ApplicationFormDiscoveryRabbitConfig.QUEUE)
        admin.purgeQueue(ApplicationFormDiscoveryRabbitConfig.DEAD_QUEUE)
        jdbc.update("DELETE FROM application_form_discovery_job")
        jdbc.update(
            """INSERT IGNORE INTO support_program
                (source_code, source_program_id, title, organization, summary, categories, regions,
                 target_description, application_period_raw, application_start_date, application_end_date, source_url)
                VALUES (?, ?, ?, '테스트 기관', '테스트 공고 요약', JSON_ARRAY(), JSON_ARRAY(),
                        '테스트 지원 대상', '상시', NULL, NULL, ?)""".trimIndent(),
            form.sourceCode,
            form.sourceProgramId,
            form.programTitle,
            form.sourceUrl,
        )
        jdbc.update(
            "UPDATE support_program SET title = ? WHERE source_code = ? AND source_program_id = ?",
            form.programTitle,
            form.sourceCode,
            form.sourceProgramId,
        )
        account = newAccount()
        doAnswer { invocation ->
            invocation.getArgument<() -> Unit>(2).invoke()
            result
        }.`when`(discovery).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
    }

    @Test
    fun freePlanAnalysesThreeProgramsAMonthAndStillReplaysThatProgram() {
        val free = newAccount(plan = null)
        val cookie = cookie(free)
        val key = UUID.randomUUID().toString()
        // 이번 달에 이미 끝난 다른 공고 분석 두 건입니다. 활성 작업 3건 제한과 겹치지 않게 완료 상태로 둡니다.
        val now = LocalDateTime.now(ZoneId.of("Asia/Seoul"))
        repeat(2) {
            jdbc.update("""INSERT INTO application_form_discovery_job
                (owner_account_id, request_key, source_code, source_program_id, status, result_json, created_at, started_at, finished_at, next_publish_at)
                VALUES (?, ?, ?, ?, 'SUCCEEDED', '{}', ?, ?, ?, ?)""",
                free.id, UUID.randomUUID().toString(), form.sourceCode, "PBLN_${(100_000_000L..999_999_999L).random()}", now, now, now, now)
        }
        fun submit(requestKey: String, programId: String) = mvc.perform(post(BASE).cookie(cookie).header("Origin", "http://localhost:5173")
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"requestKey":"$requestKey","sourceCode":"${form.sourceCode}","sourceProgramId":"$programId"}"""))
        submit(key, form.sourceProgramId).andExpect(status().isAccepted)
        submit(key, form.sourceProgramId).andExpect(status().isAccepted)
        submit(UUID.randomUUID().toString(), "PBLN_000000000999999").andExpect(status().isTooManyRequests)
            .andExpect(jsonPath("$.code").value("PLAN_QUOTA_EXCEEDED"))
            .andExpect(jsonPath("$.feature").value("APPLICATION_DRAFT"))
            .andExpect(jsonPath("$.limit").value(3))
            .andExpect(jsonPath("$.used").value(3))
        // 한도를 넘은 공고의 분석 작업은 남기지 않습니다.
        assertEquals(3, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_discovery_job WHERE owner_account_id = ?", Int::class.java, free.id))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_discovery_job WHERE owner_account_id = ? AND source_program_id = ?",
            Int::class.java, free.id, "PBLN_000000000999999"))
        verify(discovery, never()).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
    }

    @Test
    fun submits202WithoutExternalWorkAndEnforcesOwnershipOriginAndIdempotency() {
        val cookie = cookie(account)
        val key = UUID.randomUUID().toString()
        val body = """{"requestKey":"$key","sourceCode":"${form.sourceCode}","sourceProgramId":"${form.sourceProgramId}"}"""
        mvc.perform(post(BASE).contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isUnauthorized)
        mvc.perform(post(BASE).cookie(cookie).header("Origin", "https://evil.example").contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden)
        repeat(2) {
            mvc.perform(post(BASE).cookie(cookie).header("Origin", "http://localhost:5173").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isAccepted).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.programTitle").value(form.programTitle))
                .andExpect(jsonPath("$.programSourceUrl").value(form.sourceUrl))
                .andExpect(jsonPath("$.status").value("QUEUED")).andExpect(jsonPath("$.result").isEmpty)
        }
        val job = jobs.listOwned(account.id).single()
        assertEquals(form.programTitle, job.programTitle)
        assertEquals(form.sourceUrl, job.programSourceUrl)
        assertNull(job.result)
        verify(discovery, never()).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        mvc.perform(get("$BASE/${job.id}").cookie(cookie(newAccount()))).andExpect(status().isNotFound)
        mvc.perform(get(BASE).cookie(cookie(newAccount()))).andExpect(jsonPath("$.length()").value(0))
        mvc.perform(get(BASE).cookie(cookie)).andExpect(status().isOk)
            .andExpect(jsonPath("$[0].programTitle").value(form.programTitle))
            .andExpect(jsonPath("$[0].programSourceUrl").value(form.sourceUrl))
        mvc.perform(post(BASE).cookie(cookie).header("Origin", "http://localhost:5173").contentType(MediaType.APPLICATION_JSON)
            .content(body.replace(key, "invalid-key"))).andExpect(status().isBadRequest)
        mvc.perform(post("/api/v1/application-preparations/forms/discover").cookie(cookie).header("Origin", "http://localhost:5173")
            .contentType(MediaType.APPLICATION_JSON).content("""{"sourceCode":"BIZINFO","sourceProgramId":"PBLN_1"}"""))
            .andExpect(status().isConflict)
    }

    @Test
    fun duplicateDeliveryExecutesOnceAndRoundTripsTheKoreanResult() {
        val job = enqueue()
        publisher.publishPending(); client.publish(job.id)
        assertEquals("QUEUED", state(job.id))
        listener.start()
        awaitState(job.id, "SUCCEEDED")
        client.publish(job.id)
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(0, admin.getQueueInfo(ApplicationFormDiscoveryRabbitConfig.QUEUE)?.messageCount) }
        listener.stop()
        verify(discovery, times(1)).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        assertEquals(result, jobs.findOwned(account.id, job.id)?.result)
        mvc.perform(get("$BASE/${job.id}").cookie(cookie(account))).andExpect(status().isOk)
            .andExpect(jsonPath("$.result.items[0].sourceProgramId").value(form.sourceProgramId))
            .andExpect(jsonPath("$.result.warnings[0]").value(result.warnings.first()))
            .andExpect(jsonPath("$.seen").value(false))
        // 끝난 분석 결과는 그 공고의 화면을 열 때 확인한 것으로 표시한다. 다른 계정의 요청은 이 계정의 작업을 바꾸지 않는다.
        val seenBody = """{"sourceCode":"${job.sourceCode}","sourceProgramId":"${job.sourceProgramId}"}"""
        mvc.perform(post("$BASE/seen").cookie(cookie(newAccount())).header("Origin", "http://localhost:5173").contentType(MediaType.APPLICATION_JSON).content(seenBody))
            .andExpect(status().isNoContent)
        mvc.perform(get(BASE).cookie(cookie(account))).andExpect(jsonPath("$[0].id").value(job.id)).andExpect(jsonPath("$[0].seen").value(false))
        mvc.perform(post("$BASE/seen").cookie(cookie(account)).header("Origin", "http://localhost:5173").contentType(MediaType.APPLICATION_JSON).content(seenBody))
            .andExpect(status().isNoContent)
        mvc.perform(get(BASE).cookie(cookie(account))).andExpect(jsonPath("$[0].seen").value(true))
    }

    @Test
    fun confirmedValidationFailureReleasesTheProgramWithoutAutomaticallyRepeatingAi() {
        doAnswer { invocation ->
            invocation.getArgument<() -> Unit>(2).invoke()
            throw ApplicationFormDiscoveryException(ApplicationFormDiscoveryException.Reason.AI_INVALID_RESPONSE)
        }.`when`(discovery).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        val job = enqueue()
        service.executeQueued(job.id)
        service.executeQueued(job.id)
        assertEquals("FAILED", state(job.id))
        assertEquals("APPLICATION_FORM_AI_INVALID_RESPONSE", jobs.findOwned(account.id, job.id)?.failureCode)
        verify(discovery, times(1)).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        val retry = enqueue()
        assertNotEquals(job.id, retry.id)
        assertEquals("QUEUED", state(retry.id))
        mvc.perform(get("$BASE/${job.id}").cookie(cookie(account))).andExpect(status().isOk)
            .andExpect(jsonPath("$.status").value("FAILED"))
            .andExpect(jsonPath("$.failureCode").value("APPLICATION_FORM_AI_INVALID_RESPONSE"))
    }

    @Test
    fun largeNativeMapResultIsRecordedBeforeJobAcknowledgement() {
        val targets = (0 until 1100).map { index ->
            mapOf("targetId" to "xlsx:cell-$index", "context" to "공식 입력칸 문맥".repeat(350))
        }
        val snapshot = ApplicationDocumentMapSnapshot("application-document-mcp-v1", "large-map-test", form.attachmentSha256,
            "native-map-v2", "test-engine", emptyList(), emptyList(), mapOf("targets" to targets))
        val largeResult = ApplicationFormDiscoveryResult(listOf(form.copy(documentMapSnapshot = snapshot)), emptyList(), false)
        `when`(discovery.discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})).thenAnswer { invocation ->
            invocation.getArgument<() -> Unit>(2).invoke()
            largeResult
        }
        val job = enqueue()
        service.executeQueued(job.id)
        assertEquals("SUCCEEDED", state(job.id))
        assertEquals(1100, (jobs.findOwned(account.id, job.id)?.result?.forms?.single()?.documentMapSnapshot
            ?.documentMap?.get("targets") as? List<*>)?.size)
    }

    @Test
    fun invalidCoreManifestAfterAiResponseIsAConfirmedFailure() {
        doAnswer { invocation ->
            invocation.getArgument<() -> Unit>(2).invoke()
            throw ai.govbiz.core._common.exception.AiServiceCallException.invalidResponse(
                "Application form discovery output could not form a safe manifest", IllegalArgumentException("invalid application form choices"))
        }.`when`(discovery).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        val job = enqueue()
        service.executeQueued(job.id)
        assertEquals("FAILED", state(job.id))
        assertEquals("APPLICATION_FORM_AI_INVALID_RESPONSE", jobs.findOwned(account.id, job.id)?.failureCode)
    }

    @Test
    fun ambiguousPaidCallRemainsUnknownAndBlocksAutomaticOrNewExecution() {
        doAnswer { invocation ->
            invocation.getArgument<() -> Unit>(2).invoke()
            throw IllegalStateException("lost response")
        }.`when`(discovery).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        val job = enqueue()
        service.executeQueued(job.id); service.executeQueued(job.id)
        assertEquals("UNKNOWN", state(job.id))
        verify(discovery, times(1)).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        assertThrows(ApplicationFormDiscoveryException::class.java) { enqueue() }
        assertEquals(1L, operations.status().single { it.feature == "application-form-discovery" }.jobs.single().count)
    }

    @Test
    fun unknownWorkIsClosedWhenAvailabilitySettlesAfterAiStartOrAfterTtlSoTheSlotReturns() {
        doAnswer { invocation ->
            invocation.getArgument<() -> Unit>(2).invoke()
            throw IllegalStateException("lost response")
        }.`when`(discovery).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        val program = "PBLN_UNKNOWN_SETTLE"
        jdbc.update("DELETE FROM application_form_availability WHERE source_code = 'BIZINFO' AND source_program_id = ?", program)
        try {
            val settled = jobs.reserve(account.id, UUID.randomUUID().toString(), "BIZINFO", program)
            service.executeQueued(settled.id)
            assertEquals("UNKNOWN", state(settled.id))
            // 가용성이 아직 분석 중이거나 AI 시작 전에 확정된 값이면 결과 불명을 그대로 둔다.
            upsertAvailability(program, "PENDING", LocalDateTime.of(2000, 1, 1, 0, 0))
            jobs.expireStaleWork()
            assertEquals("UNKNOWN", state(settled.id))
            upsertAvailability(program, "RETRY_WAITING", LocalDateTime.of(2000, 1, 1, 0, 0))
            jobs.expireStaleWork()
            assertEquals("UNKNOWN", state(settled.id))
            assertThrows(ApplicationFormDiscoveryException::class.java) { jobs.reserve(account.id, UUID.randomUUID().toString(), "BIZINFO", program) }
            // AI 시작 뒤에 확정된 가용성이 있으면 닫히고 같은 공고의 새 요청을 받는다. AI는 다시 부르지 않는다.
            upsertAvailability(program, "RETRY_WAITING", null)
            jobs.expireStaleWork()
            assertEquals("FAILED", state(settled.id))
            assertEquals("RUN_OUTCOME_SETTLED", failure(settled.id))
            val expired = jobs.reserve(account.id, UUID.randomUUID().toString(), "BIZINFO", program)
            service.executeQueued(expired.id)
            assertEquals("UNKNOWN", state(expired.id))
            // 확정된 가용성이 없어도 TTL이 지나면 닫힌다.
            upsertAvailability(program, "PENDING", LocalDateTime.of(2000, 1, 1, 0, 0))
            jobs.expireStaleWork()
            assertEquals("UNKNOWN", state(expired.id))
            jdbc.update("UPDATE application_form_discovery_job SET finished_at = '2000-01-01' WHERE id = ?", expired.id)
            jobs.expireStaleWork()
            assertEquals("FAILED", state(expired.id))
            assertEquals("RUN_OUTCOME_UNKNOWN_EXPIRED", failure(expired.id))
            assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_discovery_job WHERE owner_account_id = ? AND active_slot = 1", Int::class.java, account.id))
            assertNotNull(jobs.reserve(account.id, UUID.randomUUID().toString(), "BIZINFO", program))
            verify(discovery, times(2)).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
        } finally {
            jdbc.update("DELETE FROM application_form_availability WHERE source_code = 'BIZINFO' AND source_program_id = ?", program)
        }
    }

    @Test
    fun expiredAndInactiveWorkNeverCallsAiAndLateResultsCannotOverwriteUnknown() {
        val queued = enqueue()
        jdbc.update("UPDATE application_form_discovery_job SET created_at = '2000-01-01' WHERE id = ?", queued.id)
        jobs.expireStaleWork()
        assertEquals("FAILED", state(queued.id))
        service.executeQueued(queued.id)
        val running = enqueue()
        assertNotNull(jobs.claim(running.id))
        jdbc.update("UPDATE application_form_discovery_job SET started_at = '2000-01-01' WHERE id = ?", running.id)
        jobs.expireStaleWork()
        assertEquals("UNKNOWN", state(running.id))
        assertFalse(jobs.beginAi(running.id))
        assertThrows(IllegalStateException::class.java) { jobs.succeed(running.id, result) }
        val inactive = jobs.reserve(account.id, UUID.randomUUID().toString(), "BIZINFO", "PBLN_2")
        jdbc.update("UPDATE account SET suspended_at = CURRENT_TIMESTAMP(6) WHERE id = ?", account.id)
        service.executeQueued(inactive.id)
        jobs.expireStaleWork()
        assertEquals("FAILED", state(inactive.id))
        verify(discovery, never()).discoverQueued(anyString(), anyString(), any<() -> Unit>() ?: {})
    }

    @Test
    fun uniqueIdentityCapacityAndRollbackAreEnforcedByMysql() {
        val job = enqueue()
        assertThrows(ApplicationFormDiscoveryException::class.java) { jobs.reserve(account.id, job.requestKey, "MSIT", "1") }
        assertThrows(ApplicationFormDiscoveryException::class.java) { jobs.reserve(newAccount().id, UUID.randomUUID().toString(), form.sourceCode, form.sourceProgramId) }
        jobs.reserve(account.id, UUID.randomUUID().toString(), "MSIT", "1")
        jobs.reserve(account.id, UUID.randomUUID().toString(), "KSTARTUP", "1")
        assertThrows(ApplicationFormDiscoveryException::class.java) { jobs.reserve(account.id, UUID.randomUUID().toString(), "CNTRADE_NOTICE", "1") }
        assertEquals(3, jobs.listOwned(account.id).size)
        assertThrows(DataAccessException::class.java) { jdbc.update("UPDATE application_form_discovery_job SET status = 'INVALID' WHERE id = ?", job.id) }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO application_form_discovery_job (owner_account_id, request_key, source_code, source_program_id, created_at, next_publish_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))",
                newAccount().id, UUID.randomUUID().toString(), form.sourceCode, form.sourceProgramId)
        }
        assertEquals("QUEUED", state(job.id))
    }

    @Test
    fun brokerOutageAndMissingBindingRetainOutboxAndRecover() {
        val job = enqueue()
        assertEquals(0, rabbit.execInContainer("rabbitmqctl", "stop_app").exitCode)
        try {
            publisher.publishPending()
            val status = operations.status().single { it.feature == "application-form-discovery" }
            assertFalse(status.queue!!.available)
            assertNull(status.queue.readyMessages)
            assertEquals(1L, status.jobs.single().unconfirmedPublicationCount)
        } finally {
            assertEquals(0, rabbit.execInContainer("rabbitmqctl", "start_app").exitCode)
            factory.resetConnection(); admin.initialize()
        }
        val binding = Binding(ApplicationFormDiscoveryRabbitConfig.QUEUE, Binding.DestinationType.QUEUE,
            ApplicationFormDiscoveryRabbitConfig.EXCHANGE, ApplicationFormDiscoveryRabbitConfig.QUEUE, emptyMap())
        admin.removeBinding(binding)
        try { assertThrows(IllegalStateException::class.java) { client.publish(job.id) } } finally { admin.declareBinding(binding) }
        jdbc.update("UPDATE application_form_discovery_job SET next_publish_at = '2000-01-01' WHERE id = ?", job.id)
        publisher.publishPending(); listener.start(); awaitState(job.id, "SUCCEEDED"); listener.stop()
    }

    @Test
    fun malformedPayloadGoesToDlqAndOperationsAreAdminOnlyAndReadOnly() {
        rabbitTemplate.convertAndSend(ApplicationFormDiscoveryRabbitConfig.EXCHANGE, ApplicationFormDiscoveryRabbitConfig.QUEUE, "not-a-job")
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(1, admin.getQueueInfo(ApplicationFormDiscoveryRabbitConfig.DEAD_QUEUE)?.messageCount) }
        listener.stop()
        mvc.perform(get("/api/v1/admin/queues")).andExpect(status().isUnauthorized)
        mvc.perform(get("/api/v1/admin/queues").cookie(cookie(account))).andExpect(status().isForbidden)
        jdbc.update("UPDATE account SET role = 'ADMIN' WHERE id = ?", account.id)
        repeat(2) {
            mvc.perform(get("/api/v1/admin/queues").cookie(cookie(account))).andExpect(status().isOk)
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$[0].enabled").value(false)).andExpect(jsonPath("$[0].queue").isEmpty)
                .andExpect(jsonPath("$[2].deadQueue.readyMessages").value(1))
        }
        assertEquals(1, admin.getQueueInfo(ApplicationFormDiscoveryRabbitConfig.DEAD_QUEUE)?.messageCount)
        verifyNoInteractions(discovery)
    }

    private fun enqueue() = jobs.reserve(account.id, UUID.randomUUID().toString(), form.sourceCode, form.sourceProgramId)
    /** 한도와 무관한 흐름 테스트는 PREMIUM 계정으로 만들고, 요금제 한도 테스트만 FREE(plan = null)를 쓴다. */
    private fun newAccount(plan: String? = "PREMIUM") = accounts.createAccount(NewAccount("${UUID.randomUUID()}@form-queue.test", "hash", LocalDateTime.now()))
        .also { if (plan != null) jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, ?, NOW(6))", it.id, plan) }
    private fun cookie(account: Account): Cookie {
        val issued = sessions.issue(account.id, false)
        accounts.createSession(account.id, issued.session)
        return Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
    }
    private fun state(id: Long) = jdbc.queryForObject("SELECT status FROM application_form_discovery_job WHERE id = ?", String::class.java, id)
    private fun failure(id: Long) = jdbc.queryForObject("SELECT failure_code FROM application_form_discovery_job WHERE id = ?", String::class.java, id)
    /** 양식 가용성 한 행을 원하는 상태로 둔다. verifiedAt이 null이면 Core와 같은 서울 시계의 지금(= AI 시작 이후)으로 확정한 것으로 본다. */
    private fun upsertAvailability(program: String, status: String, verifiedAt: LocalDateTime?) {
        jdbc.update(
            """INSERT INTO application_form_availability
                (source_code, source_program_id, status, reason_code, catalog_fingerprint, verified_at, next_retry_at, attempt_count, generation, ai_started)
               VALUES ('BIZINFO', ?, ?, 'TEST', REPEAT('a', 64), ?, NULL, 0, 1, 0) AS new
               ON DUPLICATE KEY UPDATE status = new.status, verified_at = new.verified_at, lease_token = NULL, lease_until = NULL""".trimIndent(),
            program, status, verifiedAt ?: LocalDateTime.now(ZoneId.of("Asia/Seoul")).plusSeconds(1),
        )
    }
    private fun awaitState(id: Long, state: String) { await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(state, state(id)) } }

    companion object {
        const val BASE = "/api/v1/application-preparations/forms/discovery-jobs"
        @Container @JvmField val rabbit = GenericContainer("rabbitmq:4.3.5-management-alpine").withExposedPorts(5672)
            .withEnv("RABBITMQ_DEFAULT_USER", "govbiz-test").withEnv("RABBITMQ_DEFAULT_PASS", "govbiz-test")
            .withEnv("RABBITMQ_DEFAULT_VHOST", "govbiz").waitingFor(Wait.forLogMessage(".*Server startup complete.*", 1))
        @JvmStatic @DynamicPropertySource fun connection(properties: DynamicPropertyRegistry) {
            properties.add("spring.rabbitmq.host") { rabbit.host }
            properties.add("spring.rabbitmq.port") { rabbit.getMappedPort(5672) }
            properties.add("spring.rabbitmq.username") { "govbiz-test" }
            properties.add("spring.rabbitmq.password") { "govbiz-test" }
            properties.add("spring.rabbitmq.virtual-host") { "govbiz" }
        }
    }
}
