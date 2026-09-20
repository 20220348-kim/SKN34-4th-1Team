package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface MobileOAuthTransactionMapper {
    fun insert(row: MobileOAuthTransactionDbRow): Int
    fun findByStateHash(@Param("stateHash") stateHash: String): MobileOAuthTransactionDbRow?
    fun findByCodeHash(@Param("codeHash") codeHash: String): MobileOAuthTransactionDbRow?
    fun claimCallback(@Param("stateHash") stateHash: String, @Param("provider") provider: String, @Param("now") now: LocalDateTime): Int
    fun issueCode(@Param("stateHash") stateHash: String, @Param("codeHash") codeHash: String, @Param("accountId") accountId: Long,
                  @Param("expiresAt") expiresAt: LocalDateTime): Int
    fun consumeCode(@Param("codeHash") codeHash: String, @Param("redirectUri") redirectUri: String,
                    @Param("codeChallenge") codeChallenge: String, @Param("now") now: LocalDateTime): Int
    fun deleteExpired(@Param("before") before: LocalDateTime): Int
}
