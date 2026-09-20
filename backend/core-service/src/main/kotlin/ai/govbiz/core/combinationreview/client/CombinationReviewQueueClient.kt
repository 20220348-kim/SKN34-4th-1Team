package ai.govbiz.core.combinationreview.client

import ai.govbiz.core.combinationreview.config.CombinationReviewRabbitConfig
import java.util.concurrent.TimeUnit
import org.springframework.amqp.core.MessageBuilder
import org.springframework.amqp.core.MessageDeliveryMode
import org.springframework.amqp.rabbit.connection.CorrelationData
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** 작업 ID만 전송한다. 브로커 수락 및 실제 큐 라우팅을 확인한 뒤에만 성공한다. */
@Component
@ConditionalOnProperty(prefix = "app.combination-review.queue", name = ["enabled"], havingValue = "true")
class CombinationReviewQueueClient(private val rabbit: RabbitTemplate) {
    fun publish(jobId: Long) {
        require(jobId > 0)
        val correlation = CorrelationData()
        val message = MessageBuilder.withBody("v1:$jobId".toByteArray(Charsets.US_ASCII))
            .setContentType("text/plain").setContentEncoding("US-ASCII")
            .setDeliveryMode(MessageDeliveryMode.PERSISTENT).setMessageId(jobId.toString()).build()
        rabbit.send(CombinationReviewRabbitConfig.EXCHANGE, CombinationReviewRabbitConfig.QUEUE, message, correlation)
        val confirm = correlation.future.get(3, TimeUnit.SECONDS)
        check(confirm.isAck && correlation.returned == null) { "Combination review queue did not accept the job" }
    }
}
