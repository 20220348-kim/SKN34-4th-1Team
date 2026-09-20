package ai.govbiz.core.admin.domain

import java.time.LocalDateTime

data class QueueJobStatusCount(val status: String, val count: Long, val oldestAt: LocalDateTime?, val unconfirmedPublicationCount: Long)
data class BrokerQueueStatus(val available: Boolean, val readyMessages: Int?, val consumers: Int?)
data class QueueOperationsStatus(
    val feature: String,
    val enabled: Boolean,
    val queue: BrokerQueueStatus?,
    val deadQueue: BrokerQueueStatus?,
    val jobs: List<QueueJobStatusCount>,
)
