package ai.govbiz.core.combinationreview.service

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.combinationreview.client.AiCombinationReviewClient
import ai.govbiz.core.combinationreview.client.CombinationReviewQueueClient
import ai.govbiz.core.combinationreview.client.dto.*
import ai.govbiz.core.combinationreview.config.CombinationReviewRabbitConfig
import ai.govbiz.core.combinationreview.domain.*
import ai.govbiz.core.combinationreview.repository.CombinationReviewRepository
import ai.govbiz.core.combinationreview.repository.CombinationReviewRunRepository
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.document.*
import java.time.Duration
import java.time.LocalDateTime
import java.util.UUID
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.*
import org.springframework.amqp.core.Binding
import org.springframework.amqp.rabbit.core.RabbitAdmin
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory
import org.springframework.amqp.rabbit.listener.RabbitListenerEndpointRegistry
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import tools.jackson.databind.ObjectMapper

/** 실제 MySQL 8.4·RabbitMQ·문서 파서를 실행하며 외부 다운로드·AI만 스텁으로 대체한다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.kstartup.sync.enabled=false", "app.msit.sync.enabled=false",
    "app.cntrade-notice.sync.enabled=false", "app.support-program-index.enabled=false",
    "app.combination-review.queue.enabled=true", "app.daily-report.queue.enabled=false",
    "spring.rabbitmq.listener.simple.auto-startup=false", "app.ai-service.base-url=http://127.0.0.1:1",
])
@Import(MySqlTestContainerConfig::class)
@Testcontainers
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class CombinationReviewQueueIntegrationTest {
    @Autowired private lateinit var runs: CombinationReviewRunRepository
    @Autowired private lateinit var reviews: CombinationReviewRepository
    @Autowired private lateinit var service: CombinationReviewRunService
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var json: ObjectMapper
    @Autowired private lateinit var client: CombinationReviewQueueClient
    @Autowired private lateinit var template: RabbitTemplate
    @Autowired private lateinit var admin: RabbitAdmin
    @Autowired private lateinit var factory: CachingConnectionFactory
    @Autowired private lateinit var registry: RabbitListenerEndpointRegistry
    @MockitoBean private lateinit var backgroundPublisher: CombinationReviewOutboxScheduler
    @MockitoBean private lateinit var source: BizInfoAttachmentClient
    @MockitoBean private lateinit var ai: AiCombinationReviewClient
    private val listener get() = requireNotNull(registry.getListenerContainer("combinationReviewRun"))
    private val publisher get() = CombinationReviewOutboxScheduler(runs, client)
    private lateinit var request: AiCombinationReviewRequest

    @BeforeEach
    fun prepare() {
        listener.stop()
        admin.initialize()
        admin.purgeQueue(CombinationReviewRabbitConfig.QUEUE)
        admin.purgeQueue(CombinationReviewRabbitConfig.DEAD_QUEUE)
        jdbc.update("DELETE FROM combination_review")
        val answer = json.readValue(resource("contract-response.json"), AiCombinationReviewPayload::class.java)
        request = json.readValue(resource("contract-request.json"), AiCombinationReviewRequest::class.java)
        `when`(ai.configuration()).thenReturn(AiReviewConfigurationPayload(answer.contractVersion, answer.model, answer.promptVersion))
        `when`(ai.analyze(any(AiCombinationReviewRequest::class.java) ?: request)).thenReturn(answer)
        listOf("PBLN_000000000117820" to "general.hwpx", "PBLN_000000000117172" to "deeptech.hwpx").forEach { (id, name) ->
            `when`(source.collect("BIZINFO", id)).thenReturn(SupportProgramAttachments("공식 공고",
                listOf(SupportProgramAttachment("https://www.mss.go.kr/$name", name, "HWPX", resource(name))), emptyList()))
        }
    }

    @Test
    fun persistentJobsWaitForWorkerAndDuplicateDeliveryExecutesAiOnce() {
        val run = enqueue()
        publisher.publishPending()
        client.publish(run.id)
        assertEquals("QUEUED", status(run.id))
        verifyNoInteractions(source, ai)
        listener.start()
        awaitDone(run.id)
        client.publish(run.id)
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(0, admin.getQueueInfo(CombinationReviewRabbitConfig.QUEUE)?.messageCount) }
        listener.stop()
        verify(ai, times(1)).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
        assertEquals("SUCCEEDED", status(run.id))
    }

    @Test
    fun brokerOutageKeepsPendingRunAndRecoveryPublishesWithoutAnotherReservation() {
        val run = enqueue()
        assertEquals(0, rabbit.execInContainer("rabbitmqctl", "stop_app").exitCode)
        try {
            publisher.publishPending()
            assertEquals("QUEUED", status(run.id))
            assertNull(jdbc.queryForObject("SELECT last_published_at FROM combination_review_run WHERE id = ?", LocalDateTime::class.java, run.id))
        } finally {
            assertEquals(0, rabbit.execInContainer("rabbitmqctl", "start_app").exitCode)
            factory.resetConnection(); admin.initialize()
        }
        jdbc.update("UPDATE combination_review_run SET next_publish_at = '2000-01-01' WHERE id = ?", run.id)
        publisher.publishPending()
        listener.start(); awaitDone(run.id); listener.stop()
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_run", Int::class.java))
        verify(ai, times(1)).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
    }

    @Test
    fun missingBindingDoesNotFalselyMarkJobPublished() {
        val run = enqueue()
        val binding = Binding(CombinationReviewRabbitConfig.QUEUE, Binding.DestinationType.QUEUE,
            CombinationReviewRabbitConfig.EXCHANGE, CombinationReviewRabbitConfig.QUEUE, emptyMap())
        admin.removeBinding(binding)
        try {
            assertThrows(IllegalStateException::class.java) { client.publish(run.id) }
            publisher.publishPending()
            assertNull(jdbc.queryForObject("SELECT last_published_at FROM combination_review_run WHERE id = ?", LocalDateTime::class.java, run.id))
            assertEquals("QUEUED", status(run.id))
        } finally { admin.declareBinding(binding) }
    }

    @Test
    fun malformedJobIsDeadLetteredWithoutCallingSourcesOrAi() {
        template.convertAndSend(CombinationReviewRabbitConfig.EXCHANGE, CombinationReviewRabbitConfig.QUEUE, "not-a-run")
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(1, admin.getQueueInfo(CombinationReviewRabbitConfig.DEAD_QUEUE)?.messageCount) }
        listener.stop()
        verifyNoInteractions(source, ai)
    }

    @Test
    fun ambiguousAiFailureStaysUnknownAndRedeliveryDoesNotRetry() {
        val run = enqueue()
        `when`(ai.analyze(any(AiCombinationReviewRequest::class.java) ?: request)).thenThrow(IllegalStateException("connection lost"))
        publisher.publishPending(); listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals("UNKNOWN", status(run.id)) }
        client.publish(run.id)
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(0, admin.getQueueInfo(CombinationReviewRabbitConfig.QUEUE)?.messageCount) }
        listener.stop()
        assertEquals("UNKNOWN", status(run.id))
        verify(ai, times(1)).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
    }

    private fun enqueue(): StoredCombinationReviewRun {
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@review-queue.test", "hash", LocalDateTime.now()))
        val draft = CombinationReviewDraft("한글 🧪 검토", CombinationReviewInput(listOf(
            SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", "PBLN_000000000117820")),
            SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", "PBLN_000000000117172")),
        )))
        val review = reviews.create(account.id, draft)
        return service.start(account, review.id, 1, UUID.randomUUID().toString(), "추가 설명").run
    }
    private fun status(id: Long) = jdbc.queryForObject("SELECT status FROM combination_review_run WHERE id = ?", String::class.java, id)
    private fun awaitDone(id: Long) { await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals("SUCCEEDED", status(id)) } }
    private fun resource(name: String) = requireNotNull(javaClass.getResourceAsStream("/combinationreview/$name")).use { it.readBytes() }

    companion object {
        @Container @JvmField
        val rabbit = GenericContainer("rabbitmq:4.3.5-management-alpine").withExposedPorts(5672)
            .withEnv("RABBITMQ_DEFAULT_USER", "govbiz-test").withEnv("RABBITMQ_DEFAULT_PASS", "govbiz-test")
            .withEnv("RABBITMQ_DEFAULT_VHOST", "govbiz")
            .waitingFor(Wait.forLogMessage(".*Server startup complete.*", 1))
        @JvmStatic @DynamicPropertySource
        fun connection(properties: DynamicPropertyRegistry) {
            properties.add("spring.rabbitmq.host") { rabbit.host }
            properties.add("spring.rabbitmq.port") { rabbit.getMappedPort(5672) }
            properties.add("spring.rabbitmq.username") { "govbiz-test" }
            properties.add("spring.rabbitmq.password") { "govbiz-test" }
            properties.add("spring.rabbitmq.virtual-host") { "govbiz" }
        }
    }
}
