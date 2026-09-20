package ai.govbiz.core.supportprogram.service.saved

import ai.govbiz.core.supportprogram.config.SavedSupportProgramPrefetchRabbitConfig
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** 원문 수집·색인을 마치고 상태를 저장한 뒤 ACK합니다. 모호한 실패는 재전송 없이 DLQ로 격리합니다. */
@Component
@ConditionalOnProperty(prefix = "app.assistant", name = ["prefetch-queue-enabled"], havingValue = "true")
class SavedSupportProgramPrefetchConsumer(private val service: SavedSupportProgramPrefetchService) {
    private val log = LoggerFactory.getLogger(javaClass)

    @RabbitListener(
        id = "savedSupportProgramPrefetch", queues = [SavedSupportProgramPrefetchRabbitConfig.QUEUE],
        containerFactory = "savedSupportProgramPrefetchListenerContainerFactory",
    )
    fun receive(message: Message, channel: Channel) {
        val tag = message.messageProperties.deliveryTag
        val payload = if (message.body.size <= 32) message.body.toString(Charsets.US_ASCII) else ""
        val id = payload.takeIf { Regex("v1:[1-9][0-9]{0,18}").matches(it) }?.substring(3)?.toLongOrNull()
        if (id == null) {
            channel.basicReject(tag, false)
            log.warn("Invalid saved program prefetch message rejected")
            return
        }
        val recorded = try {
            service.prefetch(id)
            true
        } catch (_: Exception) {
            log.warn("Saved program prefetch outcome unconfirmed; savedId={}", id)
            false
        }
        if (recorded) channel.basicAck(tag, false) else channel.basicReject(tag, false)
    }
}
