package ai.govbiz.core.dailyreport.client

import ai.govbiz.core.dailyreport.config.DailyReportRabbitConfig
import java.util.concurrent.TimeUnit
import org.springframework.amqp.core.MessageBuilder
import org.springframework.amqp.core.MessageDeliveryMode
import org.springframework.amqp.rabbit.connection.CorrelationData
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** 작업 ID만 전송한다. 브로커 수락 및 실제 큐 라우팅을 확인한 뒤에만 성공한다. */
@Component
@ConditionalOnProperty(prefix = "app.daily-report.queue", name = ["enabled"], havingValue = "true")
class DailyReportQueueClient(private val rabbit: RabbitTemplate) {
    fun publish(jobId: Long) {
        require(jobId > 0)
        val correlation = CorrelationData()
        val message = MessageBuilder.withBody("v1:$jobId".toByteArray(Charsets.US_ASCII))
            .setContentType("text/plain").setContentEncoding("US-ASCII")
            .setDeliveryMode(MessageDeliveryMode.PERSISTENT).setMessageId(jobId.toString()).build()
        rabbit.send(DailyReportRabbitConfig.EXCHANGE, DailyReportRabbitConfig.QUEUE, message, correlation)
        val confirm = correlation.future.get(3, TimeUnit.SECONDS)
        check(confirm.isAck && correlation.returned == null) { "Daily report queue did not accept the job" }
    }
}
