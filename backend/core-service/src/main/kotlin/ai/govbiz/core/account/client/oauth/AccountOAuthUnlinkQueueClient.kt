package ai.govbiz.core.account.client.oauth

import ai.govbiz.core.account.config.AccountOAuthUnlinkRabbitConfig
import java.util.concurrent.TimeUnit
import org.springframework.amqp.core.MessageBuilder
import org.springframework.amqp.core.MessageDeliveryMode
import org.springframework.amqp.rabbit.connection.CorrelationData
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** 작업 ID만 전송한다. 브로커 수락 및 실제 큐 라우팅을 확인한 뒤에만 성공한다. */
@Component
@ConditionalOnProperty(prefix = "app.account.oauth.unlink", name = ["enabled", "queue-enabled"], havingValue = "true")
class AccountOAuthUnlinkQueueClient(private val rabbit: RabbitTemplate) {
    fun publish(jobId: Long) {
        require(jobId > 0)
        val correlation = CorrelationData()
        val message = MessageBuilder.withBody("v1:$jobId".toByteArray(Charsets.US_ASCII))
            .setContentType("text/plain").setContentEncoding("US-ASCII")
            .setDeliveryMode(MessageDeliveryMode.PERSISTENT).setMessageId(jobId.toString()).build()
        rabbit.send(AccountOAuthUnlinkRabbitConfig.EXCHANGE, AccountOAuthUnlinkRabbitConfig.QUEUE, message, correlation)
        val confirm = correlation.future.get(3, TimeUnit.SECONDS)
        check(confirm.isAck && correlation.returned == null) { "OAuth unlink queue did not accept the job" }
    }
}
