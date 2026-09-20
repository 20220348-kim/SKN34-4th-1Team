package ai.govbiz.core.supportprogram.client

import ai.govbiz.core.supportprogram.config.SavedSupportProgramPrefetchRabbitConfig
import java.util.concurrent.TimeUnit
import org.springframework.amqp.core.MessageBuilder
import org.springframework.amqp.core.MessageDeliveryMode
import org.springframework.amqp.rabbit.connection.CorrelationData
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** 관심 공고 행 id만 전송합니다. 브로커 수락과 큐 라우팅을 확인한 뒤에만 성공입니다. */
@Component
@ConditionalOnProperty(prefix = "app.assistant", name = ["prefetch-queue-enabled"], havingValue = "true")
class SavedSupportProgramPrefetchQueueClient(private val rabbit: RabbitTemplate) {
    fun publish(savedId: Long) {
        require(savedId > 0)
        val correlation = CorrelationData()
        val message = MessageBuilder.withBody("v1:$savedId".toByteArray(Charsets.US_ASCII))
            .setContentType("text/plain").setContentEncoding("US-ASCII")
            .setDeliveryMode(MessageDeliveryMode.PERSISTENT).setMessageId(savedId.toString()).build()
        rabbit.send(SavedSupportProgramPrefetchRabbitConfig.EXCHANGE, SavedSupportProgramPrefetchRabbitConfig.QUEUE, message, correlation)
        val confirm = correlation.future.get(3, TimeUnit.SECONDS)
        check(confirm.isAck && correlation.returned == null) { "Saved program prefetch queue did not accept the job" }
    }
}
