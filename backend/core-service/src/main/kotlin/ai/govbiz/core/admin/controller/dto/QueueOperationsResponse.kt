package ai.govbiz.core.admin.controller.dto

import ai.govbiz.core.admin.domain.BrokerQueueStatus
import ai.govbiz.core.admin.domain.QueueOperationsStatus
import java.time.OffsetDateTime
import java.time.ZoneId

data class QueueBrokerResponse(val available: Boolean, val readyMessages: Int?, val consumers: Int?) {
    companion object { fun from(status: BrokerQueueStatus) = QueueBrokerResponse(status.available, status.readyMessages, status.consumers) }
}
data class QueueJobCountResponse(val status: String, val count: Long, val oldestAt: OffsetDateTime?, val unconfirmedPublicationCount: Long)
data class QueueOperationsResponse(
    val feature: String, val enabled: Boolean, val queue: QueueBrokerResponse?, val deadQueue: QueueBrokerResponse?,
    val jobs: List<QueueJobCountResponse>,
) {
    companion object {
        fun from(status: QueueOperationsStatus) = QueueOperationsResponse(
            status.feature, status.enabled, status.queue?.let(QueueBrokerResponse::from), status.deadQueue?.let(QueueBrokerResponse::from),
            status.jobs.map { QueueJobCountResponse(it.status, it.count, it.oldestAt?.atZone(ZoneId.of("Asia/Seoul"))?.toOffsetDateTime(), it.unconfirmedPublicationCount) },
        )
    }
}
