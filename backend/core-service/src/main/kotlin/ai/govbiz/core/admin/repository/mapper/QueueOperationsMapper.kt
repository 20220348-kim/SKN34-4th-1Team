package ai.govbiz.core.admin.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper

@Mapper
interface QueueOperationsMapper {
    fun counts(): List<QueueOperationsDbRow>
}

data class QueueOperationsDbRow(
    var feature: String = "",
    var status: String = "",
    var count: Long = 0,
    var oldestAt: LocalDateTime? = null,
    var unconfirmedPublicationCount: Long = 0,
)
