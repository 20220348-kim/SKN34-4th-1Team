package ai.govbiz.core.account.repository.mapper

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 협업·파트너 설정 MySQL SQL을 실행하는 MyBatis Mapper입니다. 기업당 한 행이라 저장은 UPSERT입니다. */
@Mapper
interface CompanyPartnerProfileMapper {

    fun findByCompanyId(@Param("companyId") companyId: Long): CompanyPartnerProfileDbRow?

    fun upsert(row: CompanyPartnerProfileDbRow): Int
}
