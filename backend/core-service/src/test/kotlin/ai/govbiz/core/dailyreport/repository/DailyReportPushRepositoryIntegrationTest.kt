package ai.govbiz.core.dailyreport.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.*
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.dailyreport.domain.*
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

@SpringBootTest(properties = ["app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false", "app.daily-report.enabled=false",
    "app.ai-service.base-url=http://127.0.0.1:1", "app.daily-report.push.enabled=false"])
@Import(MySqlTestContainerConfig::class)
class DailyReportPushRepositoryIntegrationTest {
    @Autowired private lateinit var push: DailyReportPushRepository
    @Autowired private lateinit var reports: DailyReportRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var companies: CompanyRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactions: PlatformTransactionManager
    private val id = "a4a15267-866c-4df0-bb91-55d7c14d7a72"
    private val token = "ExpoPushToken[test_device_token]"
    private val today get() = LocalDate.now(ZoneId.of("Asia/Seoul"))

    @BeforeEach
    fun clean() { jdbc.update("DELETE FROM account WHERE email LIKE '%@push-report.test'") }

    @Test
    fun pushOnlySubscriberIsDueWithoutEmailAndOnlyReadyReportsAreReservedOnce() {
        val owner = account("owner")
        register(owner)
        assertTrue(push.enabled(id, owner.id))
        assertFalse(push.enabled(id, owner.id + 1))
        assertNull(reports.subscription(owner.id))
        assertTrue(push.dueAccounts(today, 20).contains(owner.id))
        val report = reserve(owner)
        push.reserveDeliveries(today)
        assertTrue(push.pending().none { it.reportId == report.id })
        assertTrue(reports.succeed(report, DailyReportContent(emptyList(), listOf("한글 & 특수문자 🧪"))))
        assertNotNull(reports.owned(owner.id, report.id))
        assertNull(reports.owned(owner.id + 1, report.id))
        push.reserveDeliveries(today); push.reserveDeliveries(today)
        val delivery = push.pending().single { it.reportId == report.id }
        assertTrue(push.claim(delivery.id)); assertFalse(push.claim(delivery.id))
        push.finish(delivery, DailyReportPushOutcome("ACCEPTED", "ticket-id"))
        jdbc.update("UPDATE daily_report_push_delivery SET receipt_due_at = '2000-01-01' WHERE id = ?", delivery.id)
        val receipt = push.receipts().single { it.id == delivery.id }
        push.finish(receipt, DailyReportPushOutcome("FAILED", errorCode = "DeviceNotRegistered"))
        assertFalse(push.enabled(id, owner.id))
        push.reserveDeliveries(today)
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM daily_report_push_delivery WHERE report_id = ?", Int::class.java, report.id))
    }

    @Test
    fun sessionLogoutAndTokenRotationPreventPendingDeliveryAndRollbackPreservesSettings() {
        val owner = account("session")
        register(owner)
        val report = reserve(owner)
        reports.succeed(report, DailyReportContent(emptyList(), emptyList()))
        push.reserveDeliveries(today)
        val delivery = push.pending().single { it.reportId == report.id }
        push.register(id, owner.id, "a".repeat(64), "ExpoPushToken[rotated]")
        assertFalse(push.claim(delivery.id))
        assertThrows(IllegalStateException::class.java) {
            TransactionTemplate(transactions).executeWithoutResult { push.disable(id, owner.id); error("rollback") }
        }
        assertTrue(push.enabled(id, owner.id))
        accounts.deleteSessionByTokenHash("a".repeat(64))
        assertFalse(push.hasSubscriber(owner.id))
        assertFalse(push.claim(delivery.id))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM daily_report_push_delivery WHERE report_id = ?", Int::class.java, report.id))
    }

    @Test
    fun expiredAndSuspendedSessionsNeverGenerateOrSendAndAnotherAccountCannotDisable() {
        val owner = account("expiry")
        register(owner)
        push.disable(id, owner.id + 1)
        assertTrue(push.hasSubscriber(owner.id))
        jdbc.update("UPDATE account_session SET expires_at = '2000-01-01' WHERE account_id = ?", owner.id)
        assertFalse(push.hasSubscriber(owner.id))
        jdbc.update("UPDATE account_session SET expires_at = '2100-01-01' WHERE account_id = ?", owner.id)
        jdbc.update("UPDATE account SET suspended_at = NOW(6) WHERE id = ?", owner.id)
        assertFalse(push.hasSubscriber(owner.id))
        assertFalse(push.dueAccounts(today, 100).contains(owner.id))
    }

    private fun account(label: String): Account {
        val now = LocalDateTime.now(ZoneId.of("Asia/Seoul"))
        val owner = accounts.createAccount(NewAccount("$label@push-report.test", "hash", now))
        companies.createCompany(NewCompany(owner.id, owner.id.toString().padStart(10, '0'), "서울 🧪 기업", "계속사업자", "01",
            CompanyProfileInput("서울", "정보통신업", 2020, null), now))
        accounts.createSession(owner.id, NewAccountSession("a".repeat(64), now.plusDays(1)))
        return owner
    }
    private fun register(owner: Account) = push.register(id, owner.id, "a".repeat(64), token)
    private fun reserve(owner: Account) = reports.reserve(owner.id, today, DailyReportInput("서울 🧪 기업", "서울", "정보통신업", "AI"), 1000).report
}
