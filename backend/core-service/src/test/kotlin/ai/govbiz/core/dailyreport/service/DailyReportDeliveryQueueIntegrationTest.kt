package ai.govbiz.core.dailyreport.service

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.*
import ai.govbiz.core.account.helper.AccountTestHelper.anyValue
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.admin.service.QueueOperationsService
import ai.govbiz.core.dailyreport.client.DailyReportDeliveryQueueClient
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.client.exception.DailyReportMailException
import ai.govbiz.core.dailyreport.config.*
import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.time.*
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentCaptor
import org.mockito.Mockito.*
import org.springframework.amqp.core.Binding
import org.springframework.amqp.core.Message
import org.springframework.amqp.core.MessageDeliveryMode
import org.springframework.amqp.rabbit.core.RabbitAdmin
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory
import org.springframework.amqp.rabbit.listener.RabbitListenerEndpointRegistry
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers

/** 실제 MySQL 8.4·RabbitMQ. SMTP와 AI 경계를 스텁 처리하여 외부 메일·유료 호출을 하지 않는다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.kstartup.sync.enabled=false", "app.msit.sync.enabled=false",
    "app.cntrade-notice.sync.enabled=false", "app.support-program-index.enabled=false",
    "app.daily-report.enabled=false", "app.daily-report.mail-enabled=false", "app.daily-report.send-hour=0",
    "app.daily-report.queue.enabled=false", "app.daily-report.queue.delivery-enabled=true",
    "app.ai-service.base-url=http://127.0.0.1:1",
])
@Import(MySqlTestContainerConfig::class)
@Testcontainers
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class DailyReportDeliveryQueueIntegrationTest {
    @MockitoSpyBean private lateinit var repository: DailyReportRepository
    @MockitoSpyBean private lateinit var consumer: DailyReportDeliveryConsumer
    @Autowired private lateinit var reports: DailyReportService
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var companies: CompanyRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactions: PlatformTransactionManager
    @Autowired private lateinit var client: DailyReportDeliveryQueueClient
    @Autowired private lateinit var template: RabbitTemplate
    @Autowired private lateinit var admin: RabbitAdmin
    @Autowired private lateinit var factory: CachingConnectionFactory
    @Autowired private lateinit var registry: RabbitListenerEndpointRegistry
    @Autowired private lateinit var operations: QueueOperationsService
    @MockitoBean private lateinit var backgroundPublisher: DailyReportDeliveryOutboxScheduler
    @MockitoBean private lateinit var mail: DailyReportMailClient
    @MockitoBean private lateinit var search: SupportProgramSearchService
    @MockitoBean private lateinit var evidence: SupportProgramEvidenceService

    private val today get() = LocalDate.now(ZoneId.of("Asia/Seoul"))
    private val listener get() = requireNotNull(registry.getListenerContainer("dailyReportDelivery"))
    private val publisher get() = DailyReportDeliveryOutboxScheduler(repository, client)

    @BeforeEach
    fun prepare() {
        listener.stop()
        admin.initialize()
        admin.purgeQueue(DailyReportDeliveryRabbitConfig.QUEUE)
        admin.purgeQueue(DailyReportDeliveryRabbitConfig.DEAD_QUEUE)
        jdbc.update("DELETE FROM daily_report")
        jdbc.update("DELETE FROM daily_report_subscription")
        jdbc.update("DELETE FROM daily_report_generation_budget")
        jdbc.update("DELETE FROM company WHERE account_id IN (SELECT id FROM account WHERE email LIKE '%@delivery-queue.test')")
        jdbc.update("DELETE FROM account WHERE email LIKE '%@delivery-queue.test'")
        doReturn(true).`when`(mail).isAvailable()
    }

    @Test
    fun queuedReportSurvivesUntilConsumerStartsAndDuplicateMessagesSendOnlyOnce() {
        val report = ready("normal")
        assertTrue(repository.enqueueDelivery(report.id))
        assertFalse(repository.enqueueDelivery(report.id))
        publisher.publishPending()
        assertNotNull(jdbc.queryForObject("SELECT delivery_last_published_at FROM daily_report WHERE id = ?", LocalDateTime::class.java, report.id))
        client.publish(report.id)
        client.publish(report.id)
        verify(mail, never()).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
        listener.start()
        awaitDelivery(report, DailyReportDeliveryStatus.SENT)
        awaitEmptyQueue()
        listener.stop()
        // single-active-consumer quorum 큐는 basic.get을 지원하지 않으므로 실제 수신 메시지를 확인한다.
        val messages = ArgumentCaptor.forClass(Message::class.java)
        verify(consumer, times(3)).receive(messages.capture() ?: Message(ByteArray(0)), anyValue())
        messages.allValues.forEach {
            assertEquals("v1:${report.id}", it.body.toString(Charsets.US_ASCII))
            assertEquals(MessageDeliveryMode.PERSISTENT, it.messageProperties.receivedDeliveryMode)
        }
        verify(mail, times(1)).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
        verifyNoInteractions(search, evidence)
        assertEquals(1, repository.forDay(report.accountId, today)?.generationAttempts)
        val status = operations.status().single { it.feature == "daily-report-delivery" }
        assertTrue(status.queue!!.available)
        assertEquals("SENT", status.jobs.single().status)
        assertEquals(1L, status.jobs.single().count)
    }

    @Test
    fun brokerOutageAndMissingBindingKeepOutboxUntilRecovered() {
        val report = ready("recovery")
        repository.enqueueDelivery(report.id)
        assertEquals(0, rabbit.execInContainer("rabbitmqctl", "stop_app").exitCode)
        try {
            publisher.publishPending()
            assertEquals(DailyReportDeliveryStatus.NOT_REQUESTED, delivery(report))
            assertNull(jdbc.queryForObject("SELECT delivery_last_published_at FROM daily_report WHERE id = ?", LocalDateTime::class.java, report.id))
        } finally {
            assertEquals(0, rabbit.execInContainer("rabbitmqctl", "start_app").exitCode)
            factory.resetConnection()
            admin.initialize()
        }
        val binding = Binding(DailyReportDeliveryRabbitConfig.QUEUE, Binding.DestinationType.QUEUE,
            DailyReportDeliveryRabbitConfig.EXCHANGE, DailyReportDeliveryRabbitConfig.QUEUE, emptyMap())
        admin.removeBinding(binding)
        try { assertThrows(IllegalStateException::class.java) { client.publish(report.id) } } finally { admin.declareBinding(binding) }
        makePublishable(report)
        publisher.publishPending()
        listener.start()
        awaitDelivery(report, DailyReportDeliveryStatus.SENT)
        listener.stop()
        verify(mail, times(1)).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
    }

    @Test
    fun changedSubscriptionAccountEmailAndCompanyBlockQueuedSmtp() {
        val changes = listOf<(DailyReport) -> Unit>(
            { repository.saveSettings(it.accountId, requireNotNull(accounts.findById(it.accountId)).email, "AI", false, false) },
            { jdbc.update("UPDATE account SET suspended_at = CURRENT_TIMESTAMP(6) WHERE id = ?", it.accountId) },
            { jdbc.update("UPDATE account SET email = 'changed@delivery-queue.test' WHERE id = ?", it.accountId) },
            { companies.deleteByAccountId(it.accountId) },
            { jdbc.update("UPDATE account SET deleted_at = CURRENT_TIMESTAMP(6) WHERE id = ?", it.accountId) },
        )
        changes.forEachIndexed { index, change ->
            val report = ready("changed-$index")
            repository.enqueueDelivery(report.id)
            change(report)
            reports.deliverQueued(report.id)
            repository.expireStaleWork()
            assertEquals(DailyReportDeliveryStatus.SKIPPED, delivery(report))
        }
        assertTrue(repository.publishableDeliveries().isEmpty())
        verify(mail, never()).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
    }

    @Test
    fun smtpTimeoutIsUnknownAndNeverAutomaticallyResent() {
        val report = ready("smtp-unknown")
        repository.enqueueDelivery(report.id)
        doThrow(DailyReportMailException()).`when`(mail).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
        client.publish(report.id)
        client.publish(report.id)
        listener.start()
        awaitDelivery(report, DailyReportDeliveryStatus.UNKNOWN)
        awaitEmptyQueue()
        listener.stop()
        assertTrue(repository.publishableDeliveries().isEmpty())
        assertFalse(repository.enqueueDelivery(report.id))
        verify(mail, times(1)).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
    }

    @Test
    fun databaseFailureAfterSmtpGoesToDlqAndStaleSendingBecomesUnknownWithoutResending() {
        val report = ready("db-unknown")
        repository.enqueueDelivery(report.id)
        doThrow(IllegalStateException("simulated DB outage")).`when`(repository).finishDelivery(report.id, DailyReportDeliveryStatus.SENT)
        client.publish(report.id)
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted {
            assertEquals(1, admin.getQueueInfo(DailyReportDeliveryRabbitConfig.DEAD_QUEUE)?.messageCount)
        }
        assertEquals(DailyReportDeliveryStatus.SENDING, delivery(report))
        client.publish(report.id)
        awaitEmptyQueue()
        listener.stop()
        jdbc.update("UPDATE daily_report SET delivery_started_at = '2000-01-01' WHERE id = ?", report.id)
        repository.expireStaleWork()
        assertEquals(DailyReportDeliveryStatus.UNKNOWN, delivery(report))
        assertFalse(repository.finishDelivery(report.id, DailyReportDeliveryStatus.SKIPPED))
        verify(mail, times(1)).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
    }

    @Test
    fun concurrentReservationAndClaimAreUniqueAndOutboxParticipatesInRollback() {
        val report = ready("concurrent")
        assertThrows(IllegalStateException::class.java) {
            TransactionTemplate(transactions).executeWithoutResult {
                assertTrue(repository.enqueueDelivery(report.id))
                error("rollback")
            }
        }
        assertNull(repository.queuedDelivery(report.id))
        val executor = Executors.newFixedThreadPool(2)
        try {
            assertEquals(1, executor.invokeAll(List(2) { Callable { repository.enqueueDelivery(report.id) } }).count { it.get() })
            val owner = requireNotNull(accounts.findById(report.accountId))
            assertEquals(1, executor.invokeAll(List(2) { index -> Callable {
                repository.claimDelivery(report.id, owner.email, (index + 1).toString().repeat(64))
            } }).count { it.get() })
        } finally { executor.shutdownNow() }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE daily_report SET delivery_deadline_at = NULL WHERE id = ?", report.id)
        }
    }

    @Test
    fun expiredQueuesAndUnqueuedIdsNeverSendAndSmtpDisabledKeepsPending() {
        val unqueued = ready("unqueued")
        reports.deliverQueued(unqueued.id)
        val expired = ready("expired")
        repository.enqueueDelivery(expired.id)
        jdbc.update("UPDATE daily_report SET delivery_queued_at = '2000-01-01', delivery_deadline_at = '2000-01-02' WHERE id = ?", expired.id)
        reports.deliverQueued(expired.id)
        repository.expireStaleWork()
        assertEquals(DailyReportDeliveryStatus.SKIPPED, delivery(expired))
        val pending = ready("mail-disabled")
        repository.enqueueDelivery(pending.id)
        doReturn(false).`when`(mail).isAvailable()
        reports.deliverQueued(pending.id)
        assertEquals(DailyReportDeliveryStatus.NOT_REQUESTED, delivery(pending))
        assertEquals(listOf(pending.id), repository.publishableDeliveries())
        verify(mail, never()).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
    }

    @Test
    fun schedulerExcludesQueuedRowsFromBoundedBatchAndQueueOffUsesExistingSmtpPath() {
        val queued = ready("already-queued")
        repository.enqueueDelivery(queued.id)
        val next = ready("next")
        assertEquals(listOf(next.accountId), repository.dueAccountIds(today, 1, false))
        val scheduler = DailyReportScheduler(reports, repository, accounts, mail, DailyReportProperties(sendHour = 0, maxAccountsPerRun = 1),
            Clock.system(ZoneId.of("Asia/Seoul")), DailyReportQueueProperties(true, true))
        scheduler.run()
        assertNotNull(repository.queuedDelivery(next.id))
        verify(mail, never()).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
        DailyReportScheduler(reports, repository, accounts, mail, DailyReportProperties(sendHour = 0),
            Clock.system(ZoneId.of("Asia/Seoul")), DailyReportQueueProperties(true, false)).run()
        assertEquals(DailyReportDeliveryStatus.SENT, delivery(queued))
        assertEquals(DailyReportDeliveryStatus.SENT, delivery(next))
        verifyNoInteractions(search, evidence)
    }

    @Test
    fun malformedAndOverflowMessagesAreDeadLetteredWithoutMailOrAi() {
        listOf("not-a-report", "v1:0", "v1:9223372036854775808", "x".repeat(33)).forEach {
            template.convertAndSend(DailyReportDeliveryRabbitConfig.EXCHANGE, DailyReportDeliveryRabbitConfig.QUEUE, it)
        }
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted {
            assertEquals(4, admin.getQueueInfo(DailyReportDeliveryRabbitConfig.DEAD_QUEUE)?.messageCount)
        }
        listener.stop()
        verifyNoInteractions(mail, search, evidence)
    }

    private fun ready(label: String): DailyReport {
        val owner = accounts.createAccount(NewAccount("$label@delivery-queue.test", "hash", LocalDateTime.now()))
        companies.createCompany(NewCompany(owner.id, owner.id.toString().padStart(10, '0'), "서울 AI & 수출 🧪", "계속사업자", "01",
            CompanyProfileInput("서울", "정보통신업", 2020, null), LocalDateTime.now()))
        val hash = owner.id.toString().padStart(64, '0')
        repository.reserveVerification(owner.id, owner.email, hash)
        assertTrue(repository.confirmEmail(hash))
        repository.saveSettings(owner.id, owner.email, "AI 수출", true, true)
        val report = repository.reserve(owner.id, today, DailyReportInput("서울 AI & 수출 🧪", "서울", "정보통신업", "수출"), 20).report
        assertTrue(repository.succeed(report, DailyReportContent(emptyList(), listOf("원문 확인"))))
        return requireNotNull(repository.forDay(owner.id, today))
    }

    private fun makePublishable(report: DailyReport) { jdbc.update("UPDATE daily_report SET delivery_next_publish_at = '2000-01-01' WHERE id = ?", report.id) }
    private fun delivery(report: DailyReport) = repository.forDay(report.accountId, report.reportDate)?.deliveryStatus
    private fun awaitDelivery(report: DailyReport, expected: DailyReportDeliveryStatus) {
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(expected, delivery(report)) }
    }
    private fun awaitEmptyQueue() {
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(0, admin.getQueueInfo(DailyReportDeliveryRabbitConfig.QUEUE)?.messageCount) }
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
