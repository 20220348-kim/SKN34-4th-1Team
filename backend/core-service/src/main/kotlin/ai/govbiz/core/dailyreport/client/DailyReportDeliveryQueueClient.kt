package ai.govbiz.core.dailyreport.client

import ai.govbiz.core.dailyreport.config.DailyReportDeliveryRabbitConfig
import java.util.concurrent.TimeUnit
import org.springframework.amqp.core.MessageBuilder
import org.springframework.amqp.core.MessageDeliveryMode
import org.springframework.amqp.rabbit.connection.CorrelationData
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** 작업 ID만 전송한다. 브로커 수락 및 실제 큐 라우팅을 확인한 뒤에만 성공한다. */
@Component
@ConditionalOnProperty(prefix = "app.daily-report.queue", name = ["delivery-enabled"], havingValue = "true")
class DailyReportDeliveryQueueClient(private val rabbit: RabbitTemplate) {
    fun publish(reportId: Long) {
        require(reportId > 0)
        val correlation = CorrelationData()
        val message = MessageBuilder.withBody("v1:$reportId".toByteArray(Charsets.US_ASCII))
            .setContentType("text/plain").setContentEncoding("US-ASCII")
            .setDeliveryMode(MessageDeliveryMode.PERSISTENT).setMessageId(reportId.toString()).build()
        rabbit.send(DailyReportDeliveryRabbitConfig.EXCHANGE, DailyReportDeliveryRabbitConfig.QUEUE, message, correlation)
        val confirm = correlation.future.get(3, TimeUnit.SECONDS)
        check(confirm.isAck && correlation.returned == null) { "Daily report delivery queue did not accept the report" }
    }
}
