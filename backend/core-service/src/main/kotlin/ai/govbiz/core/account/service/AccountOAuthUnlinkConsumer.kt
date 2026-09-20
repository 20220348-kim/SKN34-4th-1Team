package ai.govbiz.core.account.service

import ai.govbiz.core.account.config.AccountOAuthUnlinkRabbitConfig
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

/** DB에 성공·실패·UNKNOWN을 기록한 뒤 ACK한다. 기록 자체가 실패한 메시지는 재실행 없이 DLQ로 격리한다. */
@Component
@ConditionalOnProperty(prefix = "app.account.oauth.unlink", name = ["enabled", "queue-enabled"], havingValue = "true")
class AccountOAuthUnlinkConsumer(private val service: AccountOAuthUnlinkService) {
    private val log = LoggerFactory.getLogger(javaClass)

    @RabbitListener(id = "accountOAuthUnlink", queues = [AccountOAuthUnlinkRabbitConfig.QUEUE],
        containerFactory = "accountOAuthUnlinkListenerContainerFactory")
    fun receive(message: Message, channel: Channel) {
        val tag = message.messageProperties.deliveryTag
        val payload = if (message.body.size <= 32) message.body.toString(Charsets.US_ASCII) else ""
        val id = payload.takeIf { Regex("v1:[1-9][0-9]{0,18}").matches(it) }?.substring(3)?.toLongOrNull()
        if (id == null) {
            channel.basicReject(tag, false)
            log.warn("Invalid OAuth unlink message rejected")
            return
        }
        val recorded = try {
            service.execute(id)
            true
        } catch (_: Exception) {
            log.warn("OAuth unlink outcome unconfirmed; jobId={}", id)
            false
        }
        if (recorded) channel.basicAck(tag, false) else channel.basicReject(tag, false)
    }
}
