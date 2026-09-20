package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.dailyreport.config.DailyReportRabbitConfig
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** Core의 전용 소비자 1개. DB 완료 후 ACK하며, 미실행 작업 재발행은 Outbox가 담당한다. */
@Component
@ConditionalOnProperty(prefix = "app.daily-report.queue", name = ["enabled"], havingValue = "true")
class DailyReportGenerationConsumer(private val reports: DailyReportService) {
    private val log = LoggerFactory.getLogger(javaClass)

    @RabbitListener(id = "dailyReportGeneration", queues = [DailyReportRabbitConfig.QUEUE],
        containerFactory = "dailyReportListenerContainerFactory")
    fun receive(message: Message, channel: Channel) {
        val tag = message.messageProperties.deliveryTag
        val payload = if (message.body.size <= 32) message.body.toString(Charsets.US_ASCII) else ""
        val id = payload.takeIf { Regex("v1:[1-9][0-9]{0,18}").matches(it) }?.substring(3)?.toLongOrNull()
        if (id == null) {
            channel.basicReject(tag, false)
            log.warn("Invalid daily report job message rejected")
            return
        }
        val completed = try { reports.generateQueued(id) } catch (_: Exception) {
            log.warn("Daily report processing outcome unconfirmed; jobId={}", id)
            false
        }
        // ACK 전 연결이 끊겨도 재전달된 작업은 DB 상태로 중복 실행을 막는다.
        if (completed) channel.basicAck(tag, false) else channel.basicReject(tag, false)
    }
}
