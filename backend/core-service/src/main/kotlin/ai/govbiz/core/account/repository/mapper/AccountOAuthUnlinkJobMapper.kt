package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface AccountOAuthUnlinkJobMapper {
    fun enqueue(@Param("accountId") accountId: Long, @Param("subject") subject: String, @Param("now") now: LocalDateTime): Int
    fun findById(@Param("id") id: Long): AccountOAuthUnlinkJobDbRow?
    fun pending(@Param("now") now: LocalDateTime): List<Long>
    fun reservePublication(@Param("id") id: Long, @Param("now") now: LocalDateTime, @Param("next") next: LocalDateTime): Int
    fun markPublished(@Param("id") id: Long, @Param("now") now: LocalDateTime): Int
    fun claim(@Param("id") id: Long, @Param("now") now: LocalDateTime): Int
    fun finish(@Param("id") id: Long, @Param("status") status: String, @Param("failureCode") failureCode: String?, @Param("now") now: LocalDateTime): Int
    fun expireRunning(@Param("cutoff") cutoff: LocalDateTime, @Param("now") now: LocalDateTime): Int
}
