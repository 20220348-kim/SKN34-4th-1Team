package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness
import ai.govbiz.core.account.domain.Company
import ai.govbiz.core.account.domain.CompanyProfileInput
import ai.govbiz.core.account.domain.NewCompany
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.repository.CompanyPartnerProfileRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.account.service.exception.BusinessNotActiveException
import ai.govbiz.core.account.service.exception.BusinessNumberAlreadyRegisteredException
import ai.govbiz.core.account.service.exception.CompanyAlreadyRegisteredException
import ai.govbiz.core.account.service.exception.CompanyNotRegisteredException
import ai.govbiz.core.account.service.exception.CompanyProfileInvalidException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.dao.DuplicateKeyException

@ExtendWith(MockitoExtension::class)
class CompanyServiceTest {

    @Mock
    private lateinit var companyRepository: CompanyRepository

    @Mock
    private lateinit var partnerProfileRepository: CompanyPartnerProfileRepository

    @Mock
    private lateinit var lookupService: BusinessLookupService

    private lateinit var service: CompanyService

    private val account = AccountTestHelper.account(id = 7L)

    @BeforeEach
    fun setUp() {
        service = CompanyService(companyRepository, partnerProfileRepository, lookupService, AccountTestHelper.FIXED_CLOCK)
    }

    @Test
    fun registerReQueriesTheTaxServiceAndStoresItsValuesNotTheClientInput() {
        doReturn(null).`when`(companyRepository).findByAccountId(7L)
        doReturn(activeBusiness()).`when`(lookupService).lookup("1248100998")
        var created: NewCompany? = null
        doAnswer { invocation ->
            created = invocation.getArgument(0)
            company()
        }.`when`(companyRepository).createCompany(AccountTestHelper.anyValue())

        val company = service.register(account, "1248100998", profile())

        val newCompany = requireNotNull(created)
        assertEquals(7L, newCompany.accountId)
        assertEquals("1248100998", newCompany.businessNumber)
        assertEquals("삼성전자(주)", newCompany.companyName)
        assertEquals("01", newCompany.businessStatusCode)
        assertEquals(NOW, newCompany.businessVerifiedAt)
        assertEquals(profile(), newCompany.profile)
        assertEquals(company(), company)
    }

    @Test
    fun registerRejectsClosedOrSuspendedBusinesses() {
        doReturn(null).`when`(companyRepository).findByAccountId(7L)
        doReturn(activeBusiness().copy(businessStatus = "폐업자", businessStatusCode = "03"))
            .`when`(lookupService).lookup("1248100998")

        val exception = assertThrows(BusinessNotActiveException::class.java) {
            service.register(account, "1248100998", profile())
        }

        assertEquals("폐업자", exception.businessStatus)
        verify(companyRepository, never()).createCompany(AccountTestHelper.anyValue())
    }

    @Test
    fun registerRejectsASecondCompanyForTheSameAccountBeforeCallingTheTaxService() {
        doReturn(company()).`when`(companyRepository).findByAccountId(7L)

        assertThrows(CompanyAlreadyRegisteredException::class.java) { service.register(account, "1248100998", profile()) }

        verify(lookupService, never()).lookup("1248100998")
    }

    @Test
    fun registerMapsTheUniqueConstraintsToTheRightConflict() {
        doReturn(null).`when`(companyRepository).findByAccountId(7L)
        doReturn(activeBusiness()).`when`(lookupService).lookup("1248100998")
        doThrow(DuplicateKeyException("Duplicate entry '1248100998' for key 'company.uq_company_business_number'"))
            .doThrow(DuplicateKeyException("Duplicate entry '7' for key 'company.uq_company_account'"))
            .`when`(companyRepository).createCompany(AccountTestHelper.anyValue())

        assertThrows(BusinessNumberAlreadyRegisteredException::class.java) { service.register(account, "1248100998", profile()) }
        assertThrows(CompanyAlreadyRegisteredException::class.java) { service.register(account, "1248100998", profile()) }
    }

    @Test
    fun registerAndUpdateRejectAFoundedYearInTheFuture() {
        doReturn(null).`when`(companyRepository).findByAccountId(7L)

        assertEquals(
            "foundedYear",
            assertThrows(CompanyProfileInvalidException::class.java) {
                service.register(account, "1248100998", profile().copy(foundedYear = NOW.year + 1))
            }.field,
        )
        assertThrows(CompanyProfileInvalidException::class.java) {
            service.updateProfile(account, profile().copy(foundedYear = NOW.year + 1))
        }
        verify(lookupService, never()).lookup("1248100998")
    }

    @Test
    fun updateAndFindReportAMissingCompany() {
        doReturn(null).`when`(companyRepository).updateProfile(7L, profile())
        doReturn(null).`when`(companyRepository).findByAccountId(7L)

        assertThrows(CompanyNotRegisteredException::class.java) { service.updateProfile(account, profile()) }
        assertThrows(CompanyNotRegisteredException::class.java) { service.findMine(account) }
    }

    private fun activeBusiness() =
        BiznoBusiness(
            businessNumber = "1248100998",
            companyName = "삼성전자(주)",
            businessStatus = "계속사업자",
            businessStatusCode = "01",
        )

    private fun profile() =
        CompanyProfileInput(
            region = "서울특별시",
            industry = "정보통신업",
            foundedYear = 2020,
            homepageUrl = null,
        )

    private fun company() =
        Company(
            id = 3L,
            accountId = 7L,
            businessNumber = "1248100998",
            companyName = "삼성전자(주)",
            businessStatus = "계속사업자",
            businessStatusCode = "01",
            profile = profile(),
            businessVerifiedAt = NOW,
            createdAt = NOW,
            updatedAt = NOW,
        )
}
