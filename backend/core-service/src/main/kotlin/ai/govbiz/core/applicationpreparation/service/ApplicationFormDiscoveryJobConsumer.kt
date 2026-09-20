package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.config.ApplicationFormDiscoveryRabbitConfig
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** 실행 상태 저장 후 ACK한다. 모호한 DB 실패는 DLQ로 격리하며 AI를 자동 재호출하지 않는다. */
@Component
@ConditionalOnProperty(prefix = "app.application-form-discovery.queue", name = ["enabled"], havingValue = "true")
class ApplicationFormDiscoveryJobConsumer(private val service: ApplicationFormDiscoveryJobService) {
    private val log = LoggerFactory.getLogger(javaClass)

    @RabbitListener(id = "applicationFormDiscoveryRun", queues = [ApplicationFormDiscoveryRabbitConfig.QUEUE],
        containerFactory = "applicationFormDiscoveryListenerContainerFactory")
    fun receive(message: Message, channel: Channel) {
        val tag = message.messageProperties.deliveryTag
        val payload = if (message.body.size <= 32) message.body.toString(Charsets.US_ASCII) else ""
        val id = payload.takeIf { Regex("v1:[1-9][0-9]{0,18}").matches(it) }?.substring(3)?.toLongOrNull()
        if (id == null) {
            channel.basicReject(tag, false)
            log.warn("Invalid application form discovery run message rejected")
            return
        }
        val recorded = try {
            service.executeQueued(id)
            true
        } catch (_: Exception) {
            log.warn("Application form discovery processing outcome unconfirmed; runId={}", id)
            false
        }
        if (recorded) channel.basicAck(tag, false) else channel.basicReject(tag, false)
    }
}
