package ai.govbiz.core.dailyreport.repository.mapper

import java.time.LocalDate
import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

data class DailyReportPushDbRow(
    var id: Long = 0, var reportId: Long = 0, var deviceId: String = "", var expoToken: String = "",
    var reportDate: LocalDate? = null, var ticketId: String? = null,
)

@Mapper
interface DailyReportPushMapper {
    fun register(@Param("deviceId") deviceId: String, @Param("accountId") accountId: Long,
        @Param("hash") hash: String, @Param("token") token: String, @Param("now") now: LocalDateTime): Int
    fun removeConflictingToken(@Param("deviceId") deviceId: String, @Param("token") token: String): Int
    fun disable(@Param("deviceId") deviceId: String, @Param("accountId") accountId: Long): Int
    fun enabled(@Param("deviceId") deviceId: String, @Param("accountId") accountId: Long,
        @Param("now") now: LocalDateTime, @Param("idleBefore") idleBefore: LocalDateTime): Boolean
    fun hasSubscriber(@Param("accountId") accountId: Long, @Param("now") now: LocalDateTime,
        @Param("idleBefore") idleBefore: LocalDateTime): Boolean
    fun dueAccounts(@Param("date") date: LocalDate, @Param("now") now: LocalDateTime,
        @Param("idleBefore") idleBefore: LocalDateTime, @Param("limit") limit: Int): List<Long>
    fun reserveDeliveries(@Param("date") date: LocalDate, @Param("now") now: LocalDateTime,
        @Param("idleBefore") idleBefore: LocalDateTime): Int
    fun pending(@Param("now") now: LocalDateTime, @Param("idleBefore") idleBefore: LocalDateTime): List<DailyReportPushDbRow>
    fun claim(@Param("id") id: Long, @Param("now") now: LocalDateTime, @Param("idleBefore") idleBefore: LocalDateTime): Int
    fun valid(@Param("id") id: Long, @Param("now") now: LocalDateTime, @Param("idleBefore") idleBefore: LocalDateTime): Boolean
    fun finish(@Param("id") id: Long, @Param("status") status: String, @Param("ticket") ticket: String?,
        @Param("error") error: String?, @Param("receiptDue") receiptDue: LocalDateTime?): Int
    fun receipts(@Param("now") now: LocalDateTime): List<DailyReportPushDbRow>
    fun invalidateToken(@Param("deviceId") deviceId: String, @Param("token") token: String): Int
    fun expire(@Param("now") now: LocalDateTime): Int
}
