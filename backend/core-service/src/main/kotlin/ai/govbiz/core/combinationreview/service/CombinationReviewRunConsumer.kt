package ai.govbiz.core.combinationreview.service

import ai.govbiz.core.combinationreview.config.CombinationReviewRabbitConfig
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** 실행 상태 저장 후 ACK한다. 모호한 DB 실패는 DLQ로 격리하며 AI를 자동 재호출하지 않는다. */
@Component
@ConditionalOnProperty(prefix = "app.combination-review.queue", name = ["enabled"], havingValue = "true")
class CombinationReviewRunConsumer(private val service: CombinationReviewRunService) {
    private val log = LoggerFactory.getLogger(javaClass)

    @RabbitListener(id = "combinationReviewRun", queues = [CombinationReviewRabbitConfig.QUEUE],
        containerFactory = "combinationReviewListenerContainerFactory")
    fun receive(message: Message, channel: Channel) {
        val tag = message.messageProperties.deliveryTag
        val payload = if (message.body.size <= 32) message.body.toString(Charsets.US_ASCII) else ""
        val id = payload.takeIf { Regex("v1:[1-9][0-9]{0,18}").matches(it) }?.substring(3)?.toLongOrNull()
        if (id == null) {
            channel.basicReject(tag, false)
            log.warn("Invalid combination review run message rejected")
            return
        }
        val recorded = try {
            service.executeQueued(id)
            true
        } catch (_: Exception) {
            log.warn("Combination review processing outcome unconfirmed; runId={}", id)
            false
        }
        if (recorded) channel.basicAck(tag, false) else channel.basicReject(tag, false)
    }
}
