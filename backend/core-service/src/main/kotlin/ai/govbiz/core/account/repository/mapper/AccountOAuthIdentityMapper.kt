package ai.govbiz.core.account.repository.mapper

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 소셜 로그인 연결(`account_oauth_identity`) SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface AccountOAuthIdentityMapper {

    fun insertIdentity(row: AccountOAuthIdentityDbRow): Int

    fun findAccountIdBySubject(
        @Param("provider") provider: String,
        @Param("subject") subject: String,
    ): Long?

    fun findIdentitiesByAccountId(@Param("accountId") accountId: Long): List<AccountOAuthIdentityDbRow>

    fun deleteNonKakaoIdentities(@Param("accountId") accountId: Long): Int

    fun hasPendingUnlink(@Param("provider") provider: String, @Param("subject") subject: String): Boolean

    fun deleteKakaoIdentity(@Param("accountId") accountId: Long, @Param("subject") subject: String): Int
}
