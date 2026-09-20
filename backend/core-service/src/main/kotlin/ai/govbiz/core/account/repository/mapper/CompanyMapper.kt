package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 기업 MySQL SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface CompanyMapper {

    fun insertCompany(row: CompanyDbRow): Int

    fun findCompanyByAccountId(@Param("accountId") accountId: Long): CompanyDbRow?

    fun updateCompanyProfile(
        @Param("accountId") accountId: Long,
        @Param("region") region: String,
        @Param("industry") industry: String,
        @Param("foundedYear") foundedYear: Int,
        @Param("homepageUrl") homepageUrl: String?,
        @Param("updatedAt") updatedAt: LocalDateTime,
    ): Int

    fun deleteCompanyByAccountId(@Param("accountId") accountId: Long): Int
}
