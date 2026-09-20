package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.dailyreport.config.DailyReportDeliveryRabbitConfig
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** DB 발송 선점과 결과 저장을 거친 뒤 ACK한다. 모호한 실패는 재전송 없이 DLQ로 격리한다. */
@Component
@ConditionalOnProperty(prefix = "app.daily-report.queue", name = ["delivery-enabled"], havingValue = "true")
class DailyReportDeliveryConsumer(private val service: DailyReportService) {
    private val log = LoggerFactory.getLogger(javaClass)

    @RabbitListener(id = "dailyReportDelivery", queues = [DailyReportDeliveryRabbitConfig.QUEUE],
        containerFactory = "dailyReportDeliveryListenerContainerFactory")
    fun receive(message: Message, channel: Channel) {
        val tag = message.messageProperties.deliveryTag
        val payload = if (message.body.size <= 32) message.body.toString(Charsets.US_ASCII) else ""
        val id = payload.takeIf { Regex("v1:[1-9][0-9]{0,18}").matches(it) }?.substring(3)?.toLongOrNull()
        if (id == null) {
            channel.basicReject(tag, false)
            log.warn("Invalid daily report delivery message rejected")
            return
        }
        val recorded = try {
            service.deliverQueued(id)
            true
        } catch (_: Exception) {
            log.warn("Daily report delivery outcome unconfirmed; reportId={}", id)
            false
        }
        if (recorded) channel.basicAck(tag, false) else channel.basicReject(tag, false)
    }
}
