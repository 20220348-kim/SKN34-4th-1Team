package ai.govbiz.core.dailyreport.repository.mapper

import java.time.LocalDate
import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface DailyReportMapper {
    fun ensureSubscription(@Param("accountId") accountId: Long, @Param("now") now: LocalDateTime): Int
    fun findSubscription(@Param("accountId") accountId: Long): DailyReportSubscriptionDbRow?
    fun lockSubscription(@Param("accountId") accountId: Long): DailyReportSubscriptionDbRow?
    fun updateSettings(@Param("accountId") accountId: Long, @Param("purpose") purpose: String, @Param("enabled") enabled: Boolean, @Param("now") now: LocalDateTime): Int
    fun reserveVerification(@Param("accountId") accountId: Long, @Param("email") email: String, @Param("hash") hash: String, @Param("now") now: LocalDateTime, @Param("expiresAt") expiresAt: LocalDateTime, @Param("retryBefore") retryBefore: LocalDateTime): Int
    fun confirmEmail(@Param("hash") hash: String, @Param("now") now: LocalDateTime): Int
    fun unsubscribe(@Param("hash") hash: String, @Param("now") now: LocalDateTime): Int
    fun tokenExists(@Param("hash") hash: String): Boolean
    fun findLatest(@Param("accountId") accountId: Long): DailyReportDbRow?
    fun findDay(@Param("accountId") accountId: Long, @Param("date") date: LocalDate): DailyReportDbRow?
    fun lockDay(@Param("accountId") accountId: Long, @Param("date") date: LocalDate): DailyReportDbRow?
    fun insertReport(row: DailyReportDbRow): Int
    fun retryReport(@Param("id") id: Long, @Param("key") key: String, @Param("now") now: LocalDateTime): Int
    fun finishReport(@Param("id") id: Long, @Param("key") key: String, @Param("status") status: String, @Param("content") content: String?, @Param("error") error: String?, @Param("now") now: LocalDateTime): Int
    fun expireGeneration(@Param("before") before: LocalDateTime): Int
    fun ensureBudget(@Param("date") date: LocalDate): Int
    fun consumeBudget(@Param("date") date: LocalDate, @Param("maximum") maximum: Int): Int
    fun claimDelivery(@Param("id") id: Long, @Param("email") email: String, @Param("hash") hash: String, @Param("now") now: LocalDateTime): Int
    fun finishDelivery(@Param("id") id: Long, @Param("status") status: String, @Param("now") now: LocalDateTime): Int
    fun expireDelivery(@Param("before") before: LocalDateTime): Int
    fun findDueAccountIds(@Param("date") date: LocalDate, @Param("limit") limit: Int, @Param("includeQueuedDeliveries") includeQueuedDeliveries: Boolean): List<Long>
    fun enqueueDelivery(@Param("id") id: Long, @Param("now") now: LocalDateTime, @Param("deadline") deadline: LocalDateTime): Int
    fun findQueuedDelivery(@Param("id") id: Long): DailyReportDbRow?
    fun findPublishableDeliveries(@Param("now") now: LocalDateTime): List<Long>
    fun reserveDeliveryPublication(@Param("id") id: Long, @Param("now") now: LocalDateTime, @Param("retryAt") retryAt: LocalDateTime): Int
    fun markDeliveryPublished(@Param("id") id: Long, @Param("now") now: LocalDateTime): Int
    fun expireQueuedDeliveries(@Param("now") now: LocalDateTime): Int
    fun insertGenerationJob(@Param("reportId") reportId: Long, @Param("key") key: String, @Param("now") now: LocalDateTime, @Param("deadline") deadline: LocalDateTime): Int
    fun hasUnknownGeneration(@Param("reportId") reportId: Long): Boolean
    fun findPublishableJobs(@Param("now") now: LocalDateTime): List<Long>
    fun reserveJobPublication(@Param("id") id: Long, @Param("now") now: LocalDateTime, @Param("retryAt") retryAt: LocalDateTime): Int
    fun markJobPublished(@Param("id") id: Long, @Param("now") now: LocalDateTime): Int
    fun claimGenerationJob(@Param("id") id: Long, @Param("now") now: LocalDateTime): Int
    fun findJobReport(@Param("id") id: Long): DailyReportDbRow?
    fun finishGenerationJob(@Param("id") id: Long, @Param("key") key: String, @Param("status") status: String, @Param("now") now: LocalDateTime): Int
    fun expireQueuedJobs(@Param("now") now: LocalDateTime): Int
    fun expireRunningJobs(@Param("before") before: LocalDateTime, @Param("now") now: LocalDateTime): Int
}
