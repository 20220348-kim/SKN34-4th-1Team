package ai.govbiz.core.account.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.Company
import ai.govbiz.core.account.domain.CompanyPartnerProfile
import ai.govbiz.core.account.domain.CompanyPartnerProfileInput
import ai.govbiz.core.account.domain.CompanyProfileInput
import ai.govbiz.core.account.domain.NewCompany
import ai.govbiz.core.account.repository.CompanyPartnerProfileRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.account.service.exception.BusinessNotActiveException
import ai.govbiz.core.account.service.exception.BusinessNumberAlreadyRegisteredException
import ai.govbiz.core.account.service.exception.CompanyAlreadyRegisteredException
import ai.govbiz.core.account.service.exception.CompanyNotRegisteredException
import ai.govbiz.core.account.service.exception.CompanyProfileInvalidException
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service

/**
 * 회원의 기업 등록·조회·수정입니다. 사업자등록번호는 [BusinessLookupService]의 사업자등록번호 조회로 확인하고 계속사업자만 등록합니다.
 * 소재지·업종·설립연도·홈페이지는 조회 결과에 없으므로 담당자 입력을 그대로 저장합니다.
 */
@Service
class CompanyService(
    private val companyRepository: CompanyRepository,
    private val partnerProfileRepository: CompanyPartnerProfileRepository,
    private val lookupService: BusinessLookupService,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    fun findMine(account: Account): Company =
        companyRepository.findByAccountId(account.id) ?: throw CompanyNotRegisteredException()

    /** 등록 시점에 다시 조회해 프런트가 보낸 상호를 믿지 않습니다. */
    fun register(account: Account, businessNumber: String, profile: CompanyProfileInput): Company {
        if (companyRepository.findByAccountId(account.id) != null) throw CompanyAlreadyRegisteredException()
        requireFoundedYearNotInFuture(profile)

        val business = lookupService.lookup(businessNumber)
        if (!business.isActive) throw BusinessNotActiveException(business.businessStatus)

        return try {
            companyRepository.createCompany(
                NewCompany(
                    accountId = account.id,
                    businessNumber = business.businessNumber,
                    companyName = business.companyName,
                    businessStatus = business.businessStatus,
                    businessStatusCode = business.businessStatusCode,
                    profile = profile,
                    businessVerifiedAt = LocalDateTime.now(clock),
                ),
            )
        } catch (exception: DuplicateKeyException) {
            // 같은 계정의 동시 등록은 계정 UNIQUE, 다른 계정이 먼저 쓴 번호는 사업자번호 UNIQUE에 걸립니다.
            if (exception.message?.contains(ACCOUNT_UNIQUE_CONSTRAINT) == true) throw CompanyAlreadyRegisteredException()
            throw BusinessNumberAlreadyRegisteredException()
        }
    }

    fun updateProfile(account: Account, profile: CompanyProfileInput): Company {
        requireFoundedYearNotInFuture(profile)
        return companyRepository.updateProfile(account.id, profile) ?: throw CompanyNotRegisteredException()
    }

    /** 설립연도 상한은 올해입니다. 요청 검증(1900~2100)을 통과한 뒤 서울 기준 시계로 다시 봅니다. */
    /** 협업·파트너 설정입니다. 기업이 없으면 404이고, 저장한 적이 없으면 비어 있는 설정을 돌려줍니다. */
    fun findPartnerProfile(account: Account): CompanyPartnerProfile =
        partnerProfileRepository.findByCompanyId(findMine(account).id)

    fun updatePartnerProfile(account: Account, input: CompanyPartnerProfileInput): CompanyPartnerProfile =
        partnerProfileRepository.save(findMine(account).id, input)

    private fun requireFoundedYearNotInFuture(profile: CompanyProfileInput) {
        if (profile.foundedYear > LocalDateTime.now(clock).year) throw CompanyProfileInvalidException("foundedYear")
    }

    companion object {
        const val ACCOUNT_UNIQUE_CONSTRAINT = "uq_company_account"

    }
}
