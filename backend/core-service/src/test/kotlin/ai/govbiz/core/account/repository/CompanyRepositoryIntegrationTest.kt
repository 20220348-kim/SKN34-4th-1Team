package ai.govbiz.core.account.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountTier
import ai.govbiz.core.account.domain.CompanyProfileInput
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.domain.NewCompany
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.dao.DuplicateKeyException
import org.springframework.jdbc.core.JdbcTemplate

/** 기업 테이블의 제약과 계정 조회에 실리는 기업 요약을 실제 MySQL 8.4에서 확인합니다. */
@SpringBootTest(
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.ai-service.connect-timeout=10ms",
        "app.ai-service.read-timeout=10ms",
        "app.bizinfo.sync.enabled=false",
        "app.support-program-index.enabled=false",
    ],
)
@Import(MySqlTestContainerConfig::class)
class CompanyRepositoryIntegrationTest {

    @Autowired
    private lateinit var companyRepository: CompanyRepository

    @Autowired
    private lateinit var accountRepository: AccountRepository

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @BeforeEach
    fun deleteRows() {
        jdbcTemplate.update("DELETE FROM company")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
    }

    @Test
    fun createsACompanyWithKoreanValuesAndLiftsTheAccountToTheCompanyTier() {
        val account = createAccount("manager@company.co.kr")
        assertEquals(AccountTier.MEMBER, account.tier)

        val company = companyRepository.createCompany(newCompany(account.id, "1248100998"))

        assertEquals("삼성전자(주)", company.companyName)
        assertEquals("정보통신업 · 소프트웨어 개발/공급", company.profile.industry)
        assertNull(company.profile.homepageUrl)
        assertEquals(company, companyRepository.findByAccountId(account.id))

        val reloaded = requireNotNull(accountRepository.findById(account.id))
        assertEquals(AccountTier.COMPANY, reloaded.tier)
        assertEquals("삼성전자(주)", reloaded.company?.companyName)
        assertEquals("1248100998", reloaded.company?.businessNumber)
        assertEquals(reloaded, accountRepository.findByEmail("manager@company.co.kr"))
    }

    @Test
    fun enforcesOneCompanyPerAccountAndOneAccountPerBusinessNumber() {
        val first = createAccount("first@company.co.kr")
        val second = createAccount("second@company.co.kr")
        companyRepository.createCompany(newCompany(first.id, "1248100998"))

        val sameAccount = assertThrows(DuplicateKeyException::class.java) {
            companyRepository.createCompany(newCompany(first.id, "1234567891"))
        }
        assertTrue(sameAccount.message.orEmpty().contains("uq_company_account"))

        val sameNumber = assertThrows(DuplicateKeyException::class.java) {
            companyRepository.createCompany(newCompany(second.id, "1248100998"))
        }
        assertTrue(sameNumber.message.orEmpty().contains("uq_company_business_number"))
        assertNull(companyRepository.findByAccountId(second.id))
    }

    @Test
    fun updatesOnlyTheEditableProfileAndKeepsTheTaxServiceValues() {
        val account = createAccount("manager@company.co.kr")
        val created = companyRepository.createCompany(newCompany(account.id, "1248100998"))

        val updated = requireNotNull(
            companyRepository.updateProfile(
                account.id,
                CompanyProfileInput(
                    region = "부산광역시",
                    industry = "제조업",
                    foundedYear = 2015,
                    homepageUrl = "https://example.co.kr",
                ),
            ),
        )

        assertEquals("부산광역시", updated.profile.region)
        assertEquals("https://example.co.kr", updated.profile.homepageUrl)
        assertEquals(created.companyName, updated.companyName)
        assertEquals(created.businessVerifiedAt, updated.businessVerifiedAt)
        assertNull(companyRepository.updateProfile(account.id + 100, updated.profile))
    }

    @Test
    fun rejectsAnOutOfRangeFoundedYearAtTheDatabase() {
        val account = createAccount("manager@company.co.kr")

        assertThrows(DataAccessException::class.java) {
            jdbcTemplate.update(
                """
                INSERT INTO company (account_id, business_number, company_name, business_status, business_status_code,
                    region, industry, founded_year, business_verified_at, created_at, updated_at)
                VALUES (?, '1248100998', '회사', '계속사업자', '01', '서울특별시', '제조업', 1800, NOW(6), NOW(6), NOW(6))
                """.trimIndent(),
                account.id,
            )
        }
    }

    @Test
    fun deletingTheCompanyDropsTheTierAndFreesTheBusinessNumber() {
        val first = createAccount("first@company.co.kr")
        val second = createAccount("second@company.co.kr")
        companyRepository.createCompany(newCompany(first.id, "1248100998"))

        assertTrue(companyRepository.deleteByAccountId(first.id))
        assertFalse(companyRepository.deleteByAccountId(first.id))
        assertEquals(AccountTier.MEMBER, requireNotNull(accountRepository.findById(first.id)).tier)
        assertNotNull(companyRepository.createCompany(newCompany(second.id, "1248100998")))
    }

    private fun createAccount(email: String): Account =
        accountRepository.createAccount(
            NewAccount(
                email = email,
                passwordHash = PASSWORD_HASH,
                termsAgreedAt = LocalDateTime.of(2026, 9, 6, 12, 0),
            ),
        )

    private fun newCompany(accountId: Long, businessNumber: String) =
        NewCompany(
            accountId = accountId,
            businessNumber = businessNumber,
            companyName = "삼성전자(주)",
            businessStatus = "계속사업자",
            businessStatusCode = "01",
            profile = CompanyProfileInput(
                region = "서울특별시",
                industry = "정보통신업 · 소프트웨어 개발/공급",
                foundedYear = 2020,
                homepageUrl = null,
            ),
            businessVerifiedAt = LocalDateTime.of(2026, 9, 8, 10, 0),
        )

    private companion object {
        const val PASSWORD_HASH = "\$2a\$10\$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    }
}
