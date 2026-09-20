package ai.govbiz.core.admin.repository

import ai.govbiz.core.admin.domain.QueueJobStatusCount
import ai.govbiz.core.admin.repository.mapper.QueueOperationsMapper
import org.springframework.stereotype.Repository

@Repository
class QueueOperationsRepository(private val mapper: QueueOperationsMapper) {
    fun counts(): Map<String, List<QueueJobStatusCount>> = mapper.counts().groupBy { it.feature }.mapValues { (_, rows) ->
        rows.map { QueueJobStatusCount(it.status, it.count, it.oldestAt, it.unconfirmedPublicationCount) }
    }
}
