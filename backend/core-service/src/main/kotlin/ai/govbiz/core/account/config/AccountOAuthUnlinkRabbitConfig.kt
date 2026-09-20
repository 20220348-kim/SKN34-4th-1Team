package ai.govbiz.core.account.config

import org.springframework.amqp.core.AcknowledgeMode
import org.springframework.amqp.core.BindingBuilder
import org.springframework.amqp.core.Declarables
import org.springframework.amqp.core.DirectExchange
import org.springframework.amqp.core.QueueBuilder
import org.springframework.amqp.rabbit.config.SimpleRabbitListenerContainerFactory
import org.springframework.amqp.rabbit.connection.ConnectionFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.account.oauth.unlink", name = ["enabled", "queue-enabled"], havingValue = "true")
class AccountOAuthUnlinkRabbitConfig {
    @Bean
    fun accountOAuthUnlinkQueues(): Declarables {
        val exchange = DirectExchange(EXCHANGE, true, false)
        val deadExchange = DirectExchange(DEAD_EXCHANGE, true, false)
        val queue = QueueBuilder.durable(QUEUE).quorum().singleActiveConsumer()
            .maxLength(1000).overflow(QueueBuilder.Overflow.rejectPublish)
            .ttl(3_600_000).deadLetterExchange(DEAD_EXCHANGE).deadLetterRoutingKey(QUEUE)
            .withArgument("x-delivery-limit", 3).withArgument("x-dead-letter-strategy", "at-least-once").build()
        val deadQueue = QueueBuilder.durable(DEAD_QUEUE).quorum()
            .maxLength(1000).overflow(QueueBuilder.Overflow.rejectPublish).build()
        return Declarables(exchange, deadExchange, queue, deadQueue,
            BindingBuilder.bind(queue).to(exchange).with(QUEUE),
            BindingBuilder.bind(deadQueue).to(deadExchange).with(QUEUE))
    }

    @Bean
    fun accountOAuthUnlinkListenerContainerFactory(connectionFactory: ConnectionFactory) = SimpleRabbitListenerContainerFactory().apply {
        setConnectionFactory(connectionFactory)
        setConcurrentConsumers(1)
        setMaxConcurrentConsumers(1)
        setPrefetchCount(1)
        setAcknowledgeMode(AcknowledgeMode.MANUAL)
        setDefaultRequeueRejected(false)
    }

    companion object {
        const val EXCHANGE = "govbiz.account.oauth-unlink.v1"
        const val QUEUE = "govbiz.account.oauth-unlink.v1"
        const val DEAD_EXCHANGE = "govbiz.account.oauth-unlink.dead.v1"
        const val DEAD_QUEUE = "govbiz.account.oauth-unlink.dead.v1"
    }
}
