package ai.govbiz.core.dailyreport.service

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.*
import ai.govbiz.core.account.helper.AccountTestHelper.anyValue
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.dailyreport.client.DailyReportQueueClient
import ai.govbiz.core.dailyreport.config.DailyReportRabbitConfig
import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.supportprogram.service.dto.*
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.readiness.SupportProgramSearchReadinessService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
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

/** 실제 MySQL·RabbitMQ를 사용하며 검색/근거 AI 경계만 스텁으로 대체한다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.kstartup.sync.enabled=false", "app.msit.sync.enabled=false",
    "app.cntrade-notice.sync.enabled=false", "app.support-program-index.enabled=false",
    "app.daily-report.enabled=false", "app.daily-report.mail-enabled=false", "app.daily-report.queue.enabled=true",
    "app.ai-service.base-url=http://127.0.0.1:1",
])
@Import(MySqlTestContainerConfig::class)
@Testcontainers
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class DailyReportQueueIntegrationTest {
    @Autowired private lateinit var repository: DailyReportRepository
    @Autowired private lateinit var reports: DailyReportService
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var companies: CompanyRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var client: DailyReportQueueClient
    @Autowired private lateinit var template: RabbitTemplate
    @Autowired private lateinit var admin: RabbitAdmin
    @Autowired private lateinit var factory: CachingConnectionFactory
    @Autowired private lateinit var registry: RabbitListenerEndpointRegistry
    @MockitoBean private lateinit var backgroundPublisher: DailyReportOutboxScheduler
    @MockitoBean private lateinit var search: SupportProgramSearchService
    @MockitoBean private lateinit var readiness: SupportProgramSearchReadinessService
    @MockitoBean private lateinit var evidence: SupportProgramEvidenceService

    private val today get() = LocalDate.now(ZoneId.of("Asia/Seoul"))
    private val listener get() = requireNotNull(registry.getListenerContainer("dailyReportGeneration"))
    private val publisher get() = DailyReportOutboxScheduler(repository, client)

    @BeforeEach
    fun prepare() {
        listener.stop()
        admin.initialize()
        admin.purgeQueue(DailyReportRabbitConfig.QUEUE)
        admin.purgeQueue(DailyReportRabbitConfig.DEAD_QUEUE)
        jdbc.update("DELETE FROM daily_report")
        jdbc.update("DELETE FROM daily_report_subscription")
        jdbc.update("DELETE FROM daily_report_generation_budget")
        jdbc.update("DELETE FROM company WHERE account_id IN (SELECT id FROM account WHERE email LIKE '%@queue.test')")
        jdbc.update("DELETE FROM account WHERE email LIKE '%@queue.test'")
        doReturn(SupportProgramSearchReadinessResult(SupportProgramSearchState.SEARCHABLE, 1, true, null, null, emptyList()))
            .`when`(readiness).get()
        doReturn(SupportProgramSearchResult("서울 AI", emptyList())).`when`(search).search(anyString(), eq(true), anyValue())
    }

    @Test
    fun durableQueueRetainsWorkUntilConsumerStartsAndDuplicateMessagesDoNotRepeatAi() {
        val owner = subscribe("normal")
        val report = reports.enqueueScheduled(owner)
        val id = repository.publishableJobs().single()
        publisher.publishPending()
        client.publish(id)
        assertEquals(DailyReportStatus.GENERATING, report.status)
        assertNotNull(jdbc.queryForObject("SELECT last_published_at FROM daily_report_generation_job WHERE id = ?", LocalDateTime::class.java, id))
        verifyNoInteractions(search, evidence)
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted {
            assertEquals(DailyReportStatus.READY, repository.forDay(owner.id, today)?.status)
            assertEquals(0, admin.getQueueInfo(DailyReportRabbitConfig.QUEUE)?.messageCount)
        }
        listener.stop()
        verify(search, times(1)).search(anyString(), eq(true), anyValue())
        assertEquals("SUCCEEDED", jobStatus(id))
        assertEquals(1, repository.forDay(owner.id, today)?.generationAttempts)
    }

    @Test
    fun brokerFailureLeavesOutboxForRetryAndRestartRecoversWithoutAnotherBudgetReservation() {
        val owner = subscribe("broker-recovery")
        reports.enqueueScheduled(owner)
        val id = repository.publishableJobs().single()
        assertEquals(0, rabbit.execInContainer("rabbitmqctl", "stop_app").exitCode)
        try {
            publisher.publishPending()
            assertEquals("QUEUED", jobStatus(id))
            assertNull(jdbc.queryForObject("SELECT last_published_at FROM daily_report_generation_job WHERE id = ?", LocalDateTime::class.java, id))
            verifyNoInteractions(search, evidence)
        } finally {
            assertEquals(0, rabbit.execInContainer("rabbitmqctl", "start_app").exitCode)
            factory.resetConnection()
            admin.initialize()
        }
        jdbc.update("UPDATE daily_report_generation_job SET next_publish_at = '2020-01-01' WHERE id = ?", id)
        publisher.publishPending()
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals("SUCCEEDED", jobStatus(id)) }
        assertEquals(1, repository.forDay(owner.id, today)?.generationAttempts)
        verify(search, times(1)).search(anyString(), eq(true), anyValue())
    }

    @Test
    fun unroutableMessageIsNotMarkedPublishedEvenWhenBrokerConfirmsIt() {
        val owner = subscribe("unroutable")
        reports.enqueueScheduled(owner)
        val id = repository.publishableJobs().single()
        val binding = Binding(DailyReportRabbitConfig.QUEUE, Binding.DestinationType.QUEUE,
            DailyReportRabbitConfig.EXCHANGE, DailyReportRabbitConfig.QUEUE, emptyMap())
        admin.removeBinding(binding)
        try {
            assertThrows(IllegalStateException::class.java) { client.publish(id) }
            publisher.publishPending()
            assertNull(jdbc.queryForObject("SELECT last_published_at FROM daily_report_generation_job WHERE id = ?", LocalDateTime::class.java, id))
            assertEquals("QUEUED", jobStatus(id))
        } finally { admin.declareBinding(binding) }
    }

    @Test
    fun unsubscribeWhileQueuedSkipsGenerationAndNeverCallsAi() {
        val owner = subscribe("unsubscribe")
        reports.enqueueScheduled(owner)
        val id = repository.publishableJobs().single()
        repository.saveSettings(owner.id, owner.email, "AI", false, false)
        publisher.publishPending()
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals("SKIPPED", jobStatus(id)) }
        verifyNoInteractions(search, evidence)
        assertEquals(DailyReportStatus.FAILED, repository.forDay(owner.id, today)?.status)
    }

    @Test
    fun malformedMessageGoesToDeadLetterQueueWithoutExecutingAnyWork() {
        template.convertAndSend(DailyReportRabbitConfig.EXCHANGE, DailyReportRabbitConfig.QUEUE, "not-a-job")
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted {
            assertEquals(1, admin.getQueueInfo(DailyReportRabbitConfig.DEAD_QUEUE)?.messageCount)
        }
        verifyNoInteractions(search, evidence)
    }

    private fun jobStatus(id: Long): String? = jdbc.queryForObject("SELECT status FROM daily_report_generation_job WHERE id = ?", String::class.java, id)
    private fun subscribe(label: String): Account {
        val owner = accounts.createAccount(NewAccount("$label@queue.test", "hash", LocalDateTime.now()))
        companies.createCompany(NewCompany(owner.id, owner.id.toString().padStart(10, '0'), "서울 AI 기업 🧪", "계속사업자", "01",
            CompanyProfileInput("서울", "정보통신업", 2020, null), LocalDateTime.now()))
        val hash = owner.id.toString().padStart(64, '0')
        repository.reserveVerification(owner.id, owner.email, hash)
        assertTrue(repository.confirmEmail(hash))
        repository.saveSettings(owner.id, owner.email, "AI", true, true)
        return owner
    }

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
