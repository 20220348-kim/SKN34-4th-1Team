package ai.govbiz.core.account.config

import ai.govbiz.core.account.client.oauth.AccountOAuthUnlinkQueueClient
import ai.govbiz.core.account.repository.AccountOAuthUnlinkRepository
import ai.govbiz.core.account.service.AccountOAuthUnlinkConsumer
import ai.govbiz.core.account.service.AccountOAuthUnlinkScheduler
import ai.govbiz.core.account.service.AccountOAuthUnlinkService
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.amqp.rabbit.connection.ConnectionFactory
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

class AccountOAuthUnlinkConfigTest {
    private val runner = ApplicationContextRunner()
        .withUserConfiguration(AccountOAuthUnlinkConfig::class.java, AccountOAuthUnlinkRabbitConfig::class.java,
            AccountOAuthUnlinkScheduler::class.java, AccountOAuthUnlinkQueueClient::class.java, AccountOAuthUnlinkConsumer::class.java)
        .withBean(AccountOAuthUnlinkRepository::class.java, { mock(AccountOAuthUnlinkRepository::class.java) })
        .withBean(AccountOAuthUnlinkService::class.java, { mock(AccountOAuthUnlinkService::class.java) })

    @Test
    fun disabledProcessingRegistersNeitherSchedulerNorRabbitEvenIfQueueFlagIsTrue() {
        runner.withPropertyValues("app.account.oauth.unlink.enabled=false", "app.account.oauth.unlink.queue-enabled=true").run {
            assertNull(it.startupFailure)
            assertTrue(it.getBeansOfType(AccountOAuthUnlinkScheduler::class.java).isEmpty())
            assertTrue(it.getBeansOfType(AccountOAuthUnlinkConsumer::class.java).isEmpty())
            assertTrue(it.getBeansOfType(AccountOAuthUnlinkQueueClient::class.java).isEmpty())
        }
    }

    @Test
    fun directModeNeedsNoRabbitBeansAndHasADedicatedSingleThreadScheduler() {
        runner.withPropertyValues("app.account.oauth.unlink.enabled=true", "app.account.oauth.unlink.queue-enabled=false").run {
            assertNull(it.startupFailure)
            assertEquals(1, it.getBeansOfType(AccountOAuthUnlinkScheduler::class.java).size)
            assertTrue(it.getBeansOfType(AccountOAuthUnlinkConsumer::class.java).isEmpty())
            val scheduler = it.getBean("accountOAuthUnlinkTaskScheduler", ThreadPoolTaskScheduler::class.java)
            assertEquals(1, scheduler.scheduledThreadPoolExecutor.corePoolSize)
        }
    }

    @Test
    fun queueModeRegistersItsPublisherConsumerAndTopology() {
        runner.withBean(RabbitTemplate::class.java, { mock(RabbitTemplate::class.java) })
            .withBean(ConnectionFactory::class.java, { mock(ConnectionFactory::class.java) })
            .withPropertyValues("app.account.oauth.unlink.enabled=true", "app.account.oauth.unlink.queue-enabled=true").run {
                assertNull(it.startupFailure)
                assertEquals(1, it.getBeansOfType(AccountOAuthUnlinkConsumer::class.java).size)
                assertEquals(1, it.getBeansOfType(AccountOAuthUnlinkQueueClient::class.java).size)
                assertTrue(it.containsBean("accountOAuthUnlinkQueues"))
            }
    }
}
