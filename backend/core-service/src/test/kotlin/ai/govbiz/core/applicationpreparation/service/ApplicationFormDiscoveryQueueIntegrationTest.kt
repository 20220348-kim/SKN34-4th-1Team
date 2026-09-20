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
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormDiscoveryJobRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import jakarta.servlet.http.Cookie
import java.time.Duration
import java.time.LocalDateTime
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
    private fun newAccount() = accounts.createAccount(NewAccount("${UUID.randomUUID()}@form-queue.test", "hash", LocalDateTime.now()))
    private fun cookie(account: Account): Cookie {
        val issued = sessions.issue(account.id, false)
        accounts.createSession(account.id, issued.session)
        return Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
    }
    private fun state(id: Long) = jdbc.queryForObject("SELECT status FROM application_form_discovery_job WHERE id = ?", String::class.java, id)
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
