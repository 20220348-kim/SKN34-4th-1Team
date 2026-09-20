package ai.govbiz.core.account.service

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.client.oauth.AccountOAuthUnlinkQueueClient
import ai.govbiz.core.account.client.oauth.KakaoOAuthClient
import ai.govbiz.core.account.client.oauth.exception.OAuthClientException
import ai.govbiz.core.account.config.AccountOAuthUnlinkRabbitConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.helper.AccountTestHelper.anyValue
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.AccountOAuthUnlinkRepository
import ai.govbiz.core.admin.service.QueueOperationsService
import java.time.Duration
import java.time.LocalDateTime
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
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.dao.DuplicateKeyException
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers

/** 실제 MySQL 8.4·RabbitMQ를 사용한다. 카카오 호출은 전부 대역이며 실제 계정의 동의를 철회하지 않는다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.kstartup.sync.enabled=false", "app.msit.sync.enabled=false",
    "app.cntrade-notice.sync.enabled=false", "app.support-program-index.enabled=false", "app.daily-report.enabled=false",
    "app.account.oauth.unlink.enabled=true", "app.account.oauth.unlink.queue-enabled=true",
    "app.ai-service.base-url=http://127.0.0.1:1",
])
@Import(MySqlTestContainerConfig::class)
@Testcontainers
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AccountOAuthUnlinkQueueIntegrationTest {
    @MockitoSpyBean private lateinit var repository: AccountOAuthUnlinkRepository
    @MockitoSpyBean private lateinit var consumer: AccountOAuthUnlinkConsumer
    @MockitoBean private lateinit var kakao: KakaoOAuthClient
    @MockitoBean private lateinit var background: AccountOAuthUnlinkScheduler
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var profile: AccountProfileService
    @Autowired private lateinit var service: AccountOAuthUnlinkService
    @Autowired private lateinit var client: AccountOAuthUnlinkQueueClient
    @Autowired private lateinit var clients: ObjectProvider<AccountOAuthUnlinkQueueClient>
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactions: PlatformTransactionManager
    @Autowired private lateinit var admin: RabbitAdmin
    @Autowired private lateinit var template: RabbitTemplate
    @Autowired private lateinit var factory: CachingConnectionFactory
    @Autowired private lateinit var registry: RabbitListenerEndpointRegistry
    @Autowired private lateinit var operations: QueueOperationsService

    private val listener get() = requireNotNull(registry.getListenerContainer("accountOAuthUnlink"))
    private fun scheduler(queue: Boolean) = AccountOAuthUnlinkScheduler(repository, service, clients, queue)

    @BeforeEach
    fun prepare() {
        listener.stop()
        admin.initialize()
        admin.purgeQueue(AccountOAuthUnlinkRabbitConfig.QUEUE)
        admin.purgeQueue(AccountOAuthUnlinkRabbitConfig.DEAD_QUEUE)
        jdbc.update("DELETE FROM account")
    }

    @Test
    fun durableWorkDuplicateMessagesAndOldMessagesAfterRejoiningUnlinkOnlyOnce() {
        val id = deletedJob()
        doAnswer {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive())
            true
        }.`when`(kakao).unlink(SUBJECT)
        scheduler(true).dispatch()
        client.publish(id)
        verifyNoInteractions(kakao)
        listener.start()
        awaitStatus(id, "SUCCEEDED")
        listener.stop()
        assertFalse(accounts.hasPendingOAuthUnlink(OAuthProvider.KAKAO, SUBJECT))
        val newAccount = accounts.createAccountWithOAuthIdentity(newAccount("다시가입"), OAuthProvider.KAKAO, SUBJECT)
        client.publish(id)
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted {
            verify(consumer, times(3)).receive(anyValue(), anyValue())
        }
        listener.stop()
        verify(kakao, times(1)).unlink(SUBJECT)
        assertEquals(newAccount.id, accounts.findByOAuthIdentity(OAuthProvider.KAKAO, SUBJECT)?.id)
        val messages = ArgumentCaptor.forClass(Message::class.java)
        verify(consumer, times(3)).receive(messages.capture() ?: Message(ByteArray(0)), anyValue())
        messages.allValues.forEach {
            assertEquals("v1:$id", it.body.toString(Charsets.US_ASCII))
            assertEquals(MessageDeliveryMode.PERSISTENT, it.messageProperties.receivedDeliveryMode)
        }
        val status = operations.status().single { it.feature == "account-oauth-unlink" }
        assertTrue(status.queue!!.available)
        assertEquals("SUCCEEDED", status.jobs.single().status)
    }

    @Test
    fun deletionAndJobRollBackTogetherAndOtherProvidersRemainIndependent() {
        val account = accounts.createAccountWithOAuthIdentity(newAccount("rollback"), OAuthProvider.KAKAO, SUBJECT)
        assertThrows(IllegalStateException::class.java) {
            TransactionTemplate(transactions).executeWithoutResult {
                profile.deleteAccount(account, null)
                error("rollback deletion")
            }
        }
        assertNotNull(accounts.findById(account.id))
        assertEquals(account.id, accounts.findByOAuthIdentity(OAuthProvider.KAKAO, SUBJECT)?.id)
        assertTrue(repository.pending().isEmpty())
        verifyNoInteractions(kakao)
        val google = accounts.createAccountWithOAuthIdentity(newAccount("google"), OAuthProvider.GOOGLE, SUBJECT)
        profile.deleteAccount(google, null)
        assertTrue(accounts.findOAuthLinks(google.id).isEmpty())
        assertEquals(account.id, accounts.findByOAuthIdentity(OAuthProvider.KAKAO, SUBJECT)?.id)
    }

    @Test
    fun retainedIdentityUniquenessRejectsConcurrentRejoiningAndDuplicateClaim() {
        val id = deletedJob()
        val executor = Executors.newFixedThreadPool(2)
        try {
            val attempts = executor.invokeAll(List(2) { index -> Callable {
                try {
                    accounts.createAccountWithOAuthIdentity(newAccount("race-$index"), OAuthProvider.KAKAO, SUBJECT)
                    false
                } catch (_: DuplicateKeyException) { true }
            } })
            assertTrue(attempts.all { it.get() })
            assertEquals(1L, jdbc.queryForObject("SELECT COUNT(*) FROM account", Long::class.java))
            assertEquals(1, executor.invokeAll(List(2) { Callable { repository.reservePublication(id) } }).count { it.get() })
            assertEquals(1, executor.invokeAll(List(2) { Callable { repository.claim(id) } }).count { it.get() != null })
        } finally { executor.shutdownNow() }
    }

    @Test
    fun timeoutRetainsRejoinGuardAndIsNotRetriedEvenOnDuplicateMessages() {
        val id = deletedJob()
        doThrow(OAuthClientException.timeout(OAuthProvider.KAKAO, null)).`when`(kakao).unlink(SUBJECT)
        client.publish(id)
        client.publish(id)
        listener.start()
        awaitStatus(id, "UNKNOWN")
        listener.stop()
        service.execute(id)
        assertTrue(repository.pending().isEmpty())
        assertTrue(accounts.hasPendingOAuthUnlink(OAuthProvider.KAKAO, SUBJECT))
        verify(kakao, times(1)).unlink(SUBJECT)
    }

    @Test
    fun missingAdminKeyIsFailedAndDirectModeUsesTheSameDurableWork() {
        val id = deletedJob()
        doReturn(false).`when`(kakao).unlink(SUBJECT)
        scheduler(false).dispatch()
        assertEquals("FAILED", status(id))
        assertEquals("NOT_CONFIGURED", jdbc.queryForObject("SELECT failure_code FROM account_oauth_unlink_job WHERE id = ?", String::class.java, id))
        scheduler(false).dispatch()
        assertTrue(accounts.hasPendingOAuthUnlink(OAuthProvider.KAKAO, SUBJECT))
        verify(kakao, times(1)).unlink(SUBJECT)
        assertEquals(0, admin.getQueueInfo(AccountOAuthUnlinkRabbitConfig.QUEUE)?.messageCount)
    }

    @Test
    fun staleClaimAndLateSuccessNeverReleaseGuard() {
        val id = deletedJob()
        val job = requireNotNull(repository.claim(id))
        jdbc.update("UPDATE account_oauth_unlink_job SET started_at = '2000-01-01' WHERE id = ?", id)
        repository.expireRunning()
        assertEquals("UNKNOWN", status(id))
        assertFalse(repository.succeed(job))
        repository.enqueue(job.accountId, job.subject)
        service.execute(id)
        assertTrue(repository.pending().isEmpty())
        assertTrue(accounts.hasPendingOAuthUnlink(OAuthProvider.KAKAO, SUBJECT))
        verifyNoInteractions(kakao)
    }

    @Test
    fun identityReleaseFailureRollsBackSuccessAndCannotDeleteAnotherAccountsIdentity() {
        val id = deletedJob()
        val job = requireNotNull(repository.claim(id))
        assertThrows(IllegalStateException::class.java) { repository.succeed(job.copy(accountId = job.accountId + 1)) }
        assertEquals("RUNNING", status(id))
        assertTrue(accounts.hasPendingOAuthUnlink(OAuthProvider.KAKAO, SUBJECT))
    }

    @Test
    fun resultPersistenceFailureGoesToDlqAndDoesNotRepeatTheExternalEffect() {
        val id = deletedJob()
        doReturn(true).`when`(kakao).unlink(SUBJECT)
        doThrow(IllegalStateException("simulated database outage")).`when`(repository).succeed(anyValue())
        client.publish(id)
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted {
            assertEquals(1, admin.getQueueInfo(AccountOAuthUnlinkRabbitConfig.DEAD_QUEUE)?.messageCount)
        }
        listener.stop()
        assertEquals("RUNNING", status(id))
        service.execute(id)
        jdbc.update("UPDATE account_oauth_unlink_job SET started_at = '2000-01-01' WHERE id = ?", id)
        repository.expireRunning()
        assertEquals("UNKNOWN", status(id))
        verify(kakao, times(1)).unlink(SUBJECT)
        assertTrue(accounts.hasPendingOAuthUnlink(OAuthProvider.KAKAO, SUBJECT))
    }

    @Test
    fun brokerOutageAndMissingRoutingLeaveWorkInMysqlUntilRecovery() {
        val id = deletedJob()
        assertEquals(0, rabbit.execInContainer("rabbitmqctl", "stop_app").exitCode)
        try {
            scheduler(true).dispatch()
            assertEquals("QUEUED", status(id))
            assertNull(jdbc.queryForObject("SELECT last_published_at FROM account_oauth_unlink_job WHERE id = ?", LocalDateTime::class.java, id))
            verifyNoInteractions(kakao)
        } finally {
            assertEquals(0, rabbit.execInContainer("rabbitmqctl", "start_app").exitCode)
            factory.resetConnection()
            admin.initialize()
        }
        val binding = Binding(AccountOAuthUnlinkRabbitConfig.QUEUE, Binding.DestinationType.QUEUE,
            AccountOAuthUnlinkRabbitConfig.EXCHANGE, AccountOAuthUnlinkRabbitConfig.QUEUE, emptyMap())
        admin.removeBinding(binding)
        try { assertThrows(IllegalStateException::class.java) { client.publish(id) } } finally { admin.declareBinding(binding) }
        jdbc.update("UPDATE account_oauth_unlink_job SET next_publish_at = '2000-01-01' WHERE id = ?", id)
        scheduler(true).dispatch()
        doReturn(true).`when`(kakao).unlink(SUBJECT)
        listener.start()
        awaitStatus(id, "SUCCEEDED")
        listener.stop()
    }

    @Test
    fun malformedPayloadIsDeadLetteredWithoutCallingKakao() {
        template.send(AccountOAuthUnlinkRabbitConfig.EXCHANGE, AccountOAuthUnlinkRabbitConfig.QUEUE, Message("v1:0".toByteArray()))
        listener.start()
        await().atMost(Duration.ofSeconds(15)).untilAsserted {
            assertEquals(1, admin.getQueueInfo(AccountOAuthUnlinkRabbitConfig.DEAD_QUEUE)?.messageCount)
        }
        listener.stop()
        verifyNoInteractions(kakao)
    }

    private fun newAccount(label: String) = NewAccount("$label@unlink.test", null, LocalDateTime.now(), emailVerifiedAt = LocalDateTime.now())
    private fun deletedJob(): Long {
        val account = accounts.createAccountWithOAuthIdentity(newAccount("회원"), OAuthProvider.KAKAO, SUBJECT)
        profile.deleteAccount(account, null)
        assertNull(accounts.findById(account.id))
        assertTrue(accounts.hasPendingOAuthUnlink(OAuthProvider.KAKAO, SUBJECT))
        return requireNotNull(jdbc.queryForObject("SELECT id FROM account_oauth_unlink_job WHERE account_id = ?", Long::class.java, account.id))
    }
    private fun status(id: Long) = jdbc.queryForObject("SELECT status FROM account_oauth_unlink_job WHERE id = ?", String::class.java, id)
    private fun awaitStatus(id: Long, expected: String) {
        await().atMost(Duration.ofSeconds(15)).untilAsserted { assertEquals(expected, status(id)) }
    }

    companion object {
        const val SUBJECT = "4012345678"
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
