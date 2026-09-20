package ai.govbiz.core.account.repository

import ai.govbiz.core.account.domain.Company
import ai.govbiz.core.account.domain.CompanyProfileInput
import ai.govbiz.core.account.domain.NewCompany
import ai.govbiz.core.account.repository.mapper.CompanyDbRow
import ai.govbiz.core.account.repository.mapper.CompanyMapper
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 계정에 등록된 기업을 MySQL에 저장하고 읽습니다. 한 계정은 기업 하나, 한 사업자번호는 기업 하나입니다. */
@Repository
class CompanyRepository(
    private val companyMapper: CompanyMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /**
     * 기업을 INSERT합니다. 같은 계정의 두 번째 등록과 다른 계정이 쓴 사업자번호는 DB UNIQUE 제약이 막고,
     * 그때의 [org.springframework.dao.DuplicateKeyException]은 호출한 Service가 제약 이름으로 구분해 변환합니다.
     */
    @Transactional
    fun createCompany(newCompany: NewCompany): Company {
        val now = LocalDateTime.now(clock)
        val row = CompanyDbRow(
            accountId = newCompany.accountId,
            businessNumber = newCompany.businessNumber,
            companyName = newCompany.companyName,
            businessStatus = newCompany.businessStatus,
            businessStatusCode = newCompany.businessStatusCode,
            region = newCompany.profile.region,
            industry = newCompany.profile.industry,
            foundedYear = newCompany.profile.foundedYear,
            homepageUrl = newCompany.profile.homepageUrl,
            businessVerifiedAt = newCompany.businessVerifiedAt,
            createdAt = now,
            updatedAt = now,
        )
        check(companyMapper.insertCompany(row) == 1) { "company row was not created" }
        return requireNotNull(companyMapper.findCompanyByAccountId(newCompany.accountId)) { "company row was not readable" }
            .toCompany()
    }

    fun findByAccountId(accountId: Long): Company? =
        companyMapper.findCompanyByAccountId(accountId)?.toCompany()

    /** 담당자가 입력하는 항목만 바꿉니다. 조회 값은 등록 때 고정됩니다. 기업이 없으면 null입니다. */
    @Transactional
    fun updateProfile(accountId: Long, profile: CompanyProfileInput): Company? {
        val updated = companyMapper.updateCompanyProfile(
            accountId = accountId,
            region = profile.region,
            industry = profile.industry,
            foundedYear = profile.foundedYear,
            homepageUrl = profile.homepageUrl,
            updatedAt = LocalDateTime.now(clock),
        )
        if (updated == 0) return null
        return findByAccountId(accountId)
    }

    /** 계정 삭제와 함께 기업 행을 지워 사업자번호를 다시 등록할 수 있게 합니다. */
    @Transactional
    fun deleteByAccountId(accountId: Long): Boolean =
        companyMapper.deleteCompanyByAccountId(accountId) == 1

    private fun CompanyDbRow.toCompany(): Company =
        Company(
            id = id,
            accountId = accountId,
            businessNumber = businessNumber,
            companyName = companyName,
            businessStatus = businessStatus,
            businessStatusCode = businessStatusCode,
            profile = CompanyProfileInput(
                region = region,
                industry = industry,
                foundedYear = foundedYear,
                homepageUrl = homepageUrl,
            ),
            businessVerifiedAt = requireNotNull(businessVerifiedAt) { "company businessVerifiedAt must not be null" },
            createdAt = requireNotNull(createdAt) { "company createdAt must not be null" },
            updatedAt = requireNotNull(updatedAt) { "company updatedAt must not be null" },
        )
}
