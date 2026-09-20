package ai.govbiz.core.supportprogram.config

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

/**
 * 관심 공고 원문 선수집 큐입니다. 담긴 공고 id만 실어 보내고 소비자가 원문 수집·청킹·색인을 합니다.
 * 일일 리포트 큐와 같은 quorum·단일 활성 소비자·재전송 3회·DLQ 규칙을 씁니다.
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(prefix = "app.assistant", name = ["prefetch-queue-enabled"], havingValue = "true")
class SavedSupportProgramPrefetchRabbitConfig {
    @Bean
    fun savedSupportProgramPrefetchQueues(): Declarables {
        val exchange = DirectExchange(EXCHANGE, true, false)
        val deadExchange = DirectExchange(DEAD_EXCHANGE, true, false)
        val queue = QueueBuilder.durable(QUEUE).quorum().singleActiveConsumer()
            .maxLength(5_000).overflow(QueueBuilder.Overflow.rejectPublish)
            .ttl(3_600_000).deadLetterExchange(DEAD_EXCHANGE).deadLetterRoutingKey(QUEUE)
            .withArgument("x-delivery-limit", 3).withArgument("x-dead-letter-strategy", "at-least-once").build()
        val deadQueue = QueueBuilder.durable(DEAD_QUEUE).quorum()
            .maxLength(5_000).overflow(QueueBuilder.Overflow.rejectPublish).build()
        return Declarables(
            exchange, deadExchange, queue, deadQueue,
            BindingBuilder.bind(queue).to(exchange).with(QUEUE),
            BindingBuilder.bind(deadQueue).to(deadExchange).with(QUEUE),
        )
    }

    @Bean
    fun savedSupportProgramPrefetchListenerContainerFactory(connectionFactory: ConnectionFactory) =
        SimpleRabbitListenerContainerFactory().apply {
            setConnectionFactory(connectionFactory)
            setConcurrentConsumers(1)
            setMaxConcurrentConsumers(1)
            setPrefetchCount(1)
            setAcknowledgeMode(AcknowledgeMode.MANUAL)
            setDefaultRequeueRejected(false)
        }

    @Bean
    fun savedSupportProgramPrefetchOutboxTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("saved-program-prefetch-outbox-")
    }

    companion object {
        const val EXCHANGE = "govbiz.saved-support-program.prefetch.v1"
        const val QUEUE = "govbiz.saved-support-program.prefetch.v1"
        const val DEAD_EXCHANGE = "govbiz.saved-support-program.prefetch.dead.v1"
        const val DEAD_QUEUE = "govbiz.saved-support-program.prefetch.dead.v1"
    }
}
