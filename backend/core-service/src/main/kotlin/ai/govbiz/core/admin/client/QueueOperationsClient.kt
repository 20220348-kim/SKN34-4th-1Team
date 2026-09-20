package ai.govbiz.core.admin.client

import ai.govbiz.core.admin.domain.BrokerQueueStatus
import com.rabbitmq.client.AMQP
import java.util.concurrent.TimeUnit
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.stereotype.Component

/** passive 조회만 수행한다. 메시지 소비, 큐 생성, DLQ 재발행은 하지 않는다. */
@Component
class QueueOperationsClient(private val rabbit: RabbitTemplate) {
    fun read(queue: String): BrokerQueueStatus = try {
        requireNotNull(rabbit.execute { channel ->
            val command = channel.asyncCompletableRpc(AMQP.Queue.Declare.Builder().queue(queue).passive(true).build())
                .get(2, TimeUnit.SECONDS)
            val result = command.method as AMQP.Queue.DeclareOk
            BrokerQueueStatus(true, result.messageCount, result.consumerCount)
        })
    } catch (_: Exception) {
        // 장애/없는 큐를 정상적인 0건으로 표시하지 않는다.
        BrokerQueueStatus(false, null, null)
    }
}
