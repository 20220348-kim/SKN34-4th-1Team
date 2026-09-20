package ai.govbiz.core.applicationpreparation.config

import org.springframework.beans.factory.annotation.Value
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
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(prefix = "app.application-form-discovery.queue", name = ["enabled"], havingValue = "true")
class ApplicationFormDiscoveryRabbitConfig {
    @Bean
    fun applicationFormDiscoveryQueues(): Declarables {
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
    fun applicationFormDiscoveryListenerContainerFactory(connectionFactory: ConnectionFactory,
        @Value("\${spring.rabbitmq.listener.simple.auto-startup:true}") autoStartup: Boolean) = SimpleRabbitListenerContainerFactory().apply {
        setConnectionFactory(connectionFactory)
        setAutoStartup(autoStartup)
        setConcurrentConsumers(1)
        setMaxConcurrentConsumers(1)
        setPrefetchCount(1)
        setAcknowledgeMode(AcknowledgeMode.MANUAL)
        setDefaultRequeueRejected(false)
    }

    @Bean
    fun applicationFormDiscoveryOutboxTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("application-form-discovery-outbox-")
    }

    companion object {
        const val EXCHANGE = "govbiz.application-form-discovery.generation.v1"
        const val QUEUE = "govbiz.application-form-discovery.generation.v1"
        const val DEAD_EXCHANGE = "govbiz.application-form-discovery.generation.dead.v1"
        const val DEAD_QUEUE = "govbiz.application-form-discovery.generation.dead.v1"
    }
}
