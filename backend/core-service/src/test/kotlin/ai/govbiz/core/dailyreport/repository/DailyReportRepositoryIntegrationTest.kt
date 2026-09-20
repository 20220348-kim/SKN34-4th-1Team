package ai.govbiz.core.dailyreport.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.*
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import java.time.LocalDate
import java.time.LocalDateTime
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false", "app.daily-report.enabled=false",
    "app.ai-service.base-url=http://127.0.0.1:1", "app.daily-report.mail-enabled=false",
])
@Import(MySqlTestContainerConfig::class)
class DailyReportRepositoryIntegrationTest {
    @Autowired private lateinit var reports: DailyReportRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var companies: CompanyRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactions: PlatformTransactionManager
    private val date = LocalDate.of(2026, 9, 9)
    private val input = DailyReportInput("서울 AI & 로봇 🧪", "서울특별시", "정보통신업", "AI 수출")

    @BeforeEach
    fun clean() {
        jdbc.update("DELETE FROM daily_report")
        jdbc.update("DELETE FROM daily_report_subscription")
        jdbc.update("DELETE FROM daily_report_generation_budget")
        // 다른 기능의 통합 테스트 자료를 건드리지 않는다. 이 클래스 계정은 기능 자료와 함께 정리된다.
        jdbc.update("DELETE FROM account WHERE email LIKE '%@daily-report.test'")
    }

    @Test
    fun settingsRequireSeparateEmailConfirmationAndExplicitConsent() {
        val account = account("settings")
        assertNull(reports.subscription(account.id))
        assertFalse(reports.saveSettings(account.id, account.email, "AI 수출", false, false).enabled)
        assertEquals(DailyReportErrorCode.EMAIL_CONFIRMATION_REQUIRED, assertThrows(DailyReportException::class.java) {
            reports.saveSettings(account.id, account.email, "AI 수출", true, true)
        }.code)
        reports.reserveVerification(account.id, account.email, "a".repeat(64))
        assertTrue(reports.confirmEmail("a".repeat(64)))
        assertFalse(reports.confirmEmail("a".repeat(64)))
        assertFalse(requireNotNull(reports.subscription(account.id)).enabled)
        assertNull(accounts.findById(account.id)?.emailVerifiedAt)
        assertEquals(DailyReportErrorCode.EMAIL_CONSENT_REQUIRED, assertThrows(DailyReportException::class.java) {
            reports.saveSettings(account.id, account.email, "AI 수출", true, false)
        }.code)
        assertTrue(reports.saveSettings(account.id, account.email, "AI 수출", true, true).enabled)
    }

    @Test
    fun expiredChangedAddressAndSuspendedAccountCannotConfirmAndRequestsAreThrottled() {
        val account = account("expiry")
        reports.reserveVerification(account.id, account.email, "b".repeat(64))
        assertEquals(DailyReportErrorCode.EMAIL_VERIFICATION_RATE_LIMITED, assertThrows(DailyReportException::class.java) {
            reports.reserveVerification(account.id, account.email, "c".repeat(64))
        }.code)
        jdbc.update("UPDATE daily_report_subscription SET verification_expires_at = '2020-01-01' WHERE account_id = ?", account.id)
        assertFalse(reports.confirmEmail("b".repeat(64)))
        jdbc.update("UPDATE daily_report_subscription SET verification_expires_at = '2100-01-01' WHERE account_id = ?", account.id)
        jdbc.update("UPDATE account SET email = 'changed@daily-report.test' WHERE id = ?", account.id)
        assertFalse(reports.confirmEmail("b".repeat(64)))
        jdbc.update("UPDATE account SET email = ?, suspended_at = NOW(6) WHERE id = ?", account.email, account.id)
        assertFalse(reports.confirmEmail("b".repeat(64)))
    }

    @Test
    fun koreanJsonCompositeIdsAndNullableScoresRoundTripAndOtherOwnersCannotRead() {
        val owner = account("owner")
        val stranger = account("stranger")
        val reserved = reports.reserve(owner.id, date, input, 20)
        val content = DailyReportContent(listOf(item("BIZINFO"), item("KSTARTUP").copy(relevanceScore = null)), listOf("첨부문서 확인 필요 🧪"))
        assertTrue(reports.succeed(reserved.report, content))
        val stored = requireNotNull(reports.latest(owner.id))
        assertEquals(input, stored.input)
        assertEquals(content, stored.content)
        assertEquals(DailyReportStatus.READY, stored.status)
        assertNotNull(stored.generatedAt)
        assertNull(reports.latest(stranger.id))
        assertNull(reports.forDay(stranger.id, date))
    }

    @Test
    fun concurrentReservationsDeduplicateAndKeepTheOriginalSnapshot() {
        val owner = account("dedup")
        reports.saveSettings(owner.id, owner.email, "", false, false)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val results = executor.invokeAll(List(2) { Callable { reports.reserve(owner.id, date, input, 20) } }).map { it.get() }
            assertEquals(1, results.count { it.acquired })
            assertEquals(1, results.map { it.report.id }.distinct().size)
            assertEquals(1, jdbc.queryForObject("SELECT attempts FROM daily_report_generation_budget WHERE report_date = ?", Int::class.java, date))
            val repeated = reports.reserve(owner.id, date, input.copy(region = "부산"), 20)
            assertFalse(repeated.acquired)
            assertEquals("서울특별시", repeated.report.input.region)
        } finally { executor.shutdownNow() }
    }

    @Test
    fun retryUsesFencingAndHasASecondAndFinalAttemptBudget() {
        val owner = account("retry")
        val first = reports.reserve(owner.id, date, input, 20).report
        jdbc.update("UPDATE daily_report SET started_at = '2020-01-01' WHERE id = ?", first.id)
        reports.expireStaleWork()
        val second = reports.reserve(owner.id, date, input.copy(region = "부산"), 20)
        assertTrue(second.acquired)
        assertEquals(2, second.report.generationAttempts)
        assertEquals(input, second.report.input)
        assertFalse(reports.succeed(first, DailyReportContent(emptyList(), emptyList())))
        assertTrue(reports.fail(second.report))
        assertFalse(reports.reserve(owner.id, date, input, 20).acquired)
        assertEquals(2, jdbc.queryForObject("SELECT attempts FROM daily_report_generation_budget WHERE report_date = ?", Int::class.java, date))
    }

    @Test
    fun exhaustedGlobalBudgetRollsBackNewReservationsAndCountsFailedAttempts() {
        val first = account("budget-one")
        val second = account("budget-two")
        val report = reports.reserve(first.id, date, input, 1).report
        reports.fail(report)
        for (id in listOf(first.id, second.id)) {
            assertEquals(DailyReportErrorCode.REPORT_DAILY_BUDGET_EXCEEDED, assertThrows(DailyReportException::class.java) {
                reports.reserve(id, date, input, 1)
            }.code)
        }
        assertNull(reports.forDay(second.id, date))
        assertEquals(1, reports.forDay(first.id, date)?.generationAttempts)
    }

    @Test
    fun concurrentAccountsShareOneAtomicDailyBudget() {
        val first = account("parallel-budget-one")
        val second = account("parallel-budget-two")
        val executor = Executors.newFixedThreadPool(2)
        try {
            val results = executor.invokeAll(listOf(first, second).map { owner -> Callable {
                try { reports.reserve(owner.id, date, input, 1).acquired }
                catch (error: DailyReportException) {
                    assertEquals(DailyReportErrorCode.REPORT_DAILY_BUDGET_EXCEEDED, error.code)
                    false
                }
            } }).map { it.get() }
            assertEquals(1, results.count { it })
            assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM daily_report", Int::class.java))
            assertEquals(1, jdbc.queryForObject("SELECT attempts FROM daily_report_generation_budget WHERE report_date = ?", Int::class.java, date))
        } finally { executor.shutdownNow() }
    }

    @Test
    fun outerRollbackRestoresBothReportAndBudget() {
        val owner = account("rollback")
        TransactionTemplate(transactions).executeWithoutResult { status ->
            reports.reserve(owner.id, date, input, 20)
            status.setRollbackOnly()
        }
        assertNull(reports.forDay(owner.id, date))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM daily_report_generation_budget", Int::class.java))
    }

    @Test
    fun deliveryIsClaimedOnceAndUnknownOutcomesAreNeverAutomaticallyRetried() {
        val owner = subscribed("delivery", "d")
        val report = ready(owner)
        assertTrue(reports.claimDelivery(report.id, owner.email, "e".repeat(64)))
        assertFalse(reports.claimDelivery(report.id, owner.email, "f".repeat(64)))
        jdbc.update("UPDATE daily_report SET delivery_started_at = '2020-01-01' WHERE id = ?", report.id)
        reports.expireStaleWork()
        assertEquals(DailyReportDeliveryStatus.UNKNOWN, reports.latest(owner.id)?.deliveryStatus)
        assertFalse(reports.claimDelivery(report.id, owner.email, "f".repeat(64)))
        assertTrue(reports.unsubscribe("e".repeat(64)))
        assertTrue(reports.unsubscribe("e".repeat(64)))
        assertFalse(requireNotNull(reports.subscription(owner.id)).enabled)
        assertFalse(reports.unsubscribe("0".repeat(64)))
    }

    @Test
    fun deliveryRejectsOptOutChangedEmailAndSuspensionAndDueReportsPrioritizeReadyRows() {
        val lower = subscribed("not-ready", "1")
        val upper = subscribed("already-ready", "2")
        val report = ready(upper)
        assertEquals(listOf(upper.id, lower.id), reports.dueAccountIds(date, 20))
        assertFalse(reports.claimDelivery(report.id, "other@daily-report.test", "3".repeat(64)))
        reports.saveSettings(upper.id, upper.email, "", false, false)
        assertFalse(reports.claimDelivery(report.id, upper.email, "3".repeat(64)))
        reports.saveSettings(upper.id, upper.email, "", true, true)
        jdbc.update("UPDATE account SET suspended_at = NOW(6) WHERE id = ?", upper.id)
        assertFalse(reports.claimDelivery(report.id, upper.email, "3".repeat(64)))
        assertEquals(listOf(lower.id), reports.dueAccountIds(date, 20))
    }

    @Test
    fun olderDeliveredEmailLinkRemainsUsableAfterANewerReport() {
        val owner = subscribed("old-link", "4")
        val first = ready(owner)
        assertTrue(reports.claimDelivery(first.id, owner.email, "5".repeat(64)))
        reports.finishDelivery(first.id, DailyReportDeliveryStatus.SENT)
        val next = reports.reserve(owner.id, date.plusDays(1), input, 20).report
        reports.succeed(next, DailyReportContent(emptyList(), emptyList()))
        assertTrue(reports.claimDelivery(next.id, owner.email, "6".repeat(64)))
        reports.finishDelivery(next.id, DailyReportDeliveryStatus.SENT)
        assertTrue(reports.unsubscribe("5".repeat(64)))
        assertFalse(requireNotNull(reports.subscription(owner.id)).enabled)
        assertTrue(reports.unsubscribe("6".repeat(64)))
    }

    @Test
    fun scheduledReservationAndOutboxRollbackTogetherWithDailyBudget() {
        val owner = account("outbox-rollback")
        val today = LocalDate.now(java.time.ZoneId.of("Asia/Seoul"))
        TransactionTemplate(transactions).executeWithoutResult { status ->
            reports.reserveScheduled(owner.id, today, input, 20)
            assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM daily_report_generation_job", Int::class.java))
            status.setRollbackOnly()
        }
        assertNull(reports.forDay(owner.id, today))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM daily_report_generation_job", Int::class.java))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM daily_report_generation_budget", Int::class.java))
    }

    @Test
    fun repeatedScheduledReservationCreatesOneJobAndPublicationReservationsAreExclusive() {
        val owner = account("outbox-dedup")
        val today = LocalDate.now(java.time.ZoneId.of("Asia/Seoul"))
        val reserved = reports.reserveScheduled(owner.id, today, input, 20)
        assertFalse(reports.reserveScheduled(owner.id, today, input.copy(region = "부산"), 20).acquired)
        val id = reports.publishableJobs().single()
        assertTrue(reports.reserveJobPublication(id))
        assertFalse(reports.reserveJobPublication(id))
        reports.markJobPublished(id)
        assertTrue(reports.publishableJobs().isEmpty())
        val claimed = requireNotNull(reports.claimGenerationJob(id))
        assertEquals(reserved.report.input, claimed.input)
        assertNull(reports.claimGenerationJob(id))
        val content = DailyReportContent(listOf(item("BIZINFO")), listOf("근거 확인 🧪"))
        reports.finishGenerationJob(id, claimed, content)
        assertEquals(content, reports.forDay(owner.id, today)?.content)
        assertEquals("SUCCEEDED", jobStatus(id))
        assertEquals(1, jdbc.queryForObject("SELECT attempts FROM daily_report_generation_budget WHERE report_date = ?", Int::class.java, today))
    }

    @Test
    fun independentWorkersCannotClaimTheSameJob() {
        val owner = account("job-concurrent")
        reports.reserveScheduled(owner.id, LocalDate.now(java.time.ZoneId.of("Asia/Seoul")), input, 20)
        val id = reports.publishableJobs().single()
        val executor = Executors.newFixedThreadPool(2)
        try {
            val claimed = executor.invokeAll(List(2) { Callable { reports.claimGenerationJob(id) } }).map { it.get() }
            assertEquals(1, claimed.count { it != null })
        } finally { executor.shutdownNow() }
    }

    @Test
    fun queuedWorkDoesNotUseTheManualPreviewTimeoutButHasItsOwnDeadline() {
        val owner = account("queue-expiry")
        val today = LocalDate.now(java.time.ZoneId.of("Asia/Seoul"))
        val report = reports.reserveScheduled(owner.id, today, input, 20).report
        val id = reports.publishableJobs().single()
        jdbc.update("UPDATE daily_report SET started_at = '2020-01-01' WHERE id = ?", report.id)
        reports.expireStaleWork()
        assertEquals(DailyReportStatus.GENERATING, reports.forDay(owner.id, today)?.status)
        jdbc.update("UPDATE daily_report_generation_job SET created_at = '2020-01-01', deadline_at = '2020-01-02' WHERE id = ?", id)
        reports.expireStaleWork()
        assertEquals("FAILED", jobStatus(id))
        assertNull(reports.claimGenerationJob(id))
        assertEquals(DailyReportStatus.FAILED, reports.forDay(owner.id, today)?.status)
    }

    @Test
    fun uncertainRunningWorkBlocksAutomaticAndManualReexecutionAndRejectsLateCompletion() {
        val owner = subscribed("job-uncertain", "7")
        val today = LocalDate.now(java.time.ZoneId.of("Asia/Seoul"))
        reports.reserveScheduled(owner.id, today, input, 20)
        val id = reports.publishableJobs().single()
        val report = requireNotNull(reports.claimGenerationJob(id))
        jdbc.update("UPDATE daily_report_generation_job SET started_at = '2020-01-01' WHERE id = ?", id)
        reports.expireStaleWork()
        assertEquals("UNKNOWN", jobStatus(id))
        assertFalse(reports.reserveScheduled(owner.id, today, input, 20).acquired)
        assertFalse(reports.reserve(owner.id, today, input, 20).acquired)
        assertFalse(reports.dueAccountIds(today, 20).contains(owner.id))
        assertThrows(IllegalStateException::class.java) { reports.finishGenerationJob(id, report, DailyReportContent(emptyList(), emptyList())) }
        assertEquals(DailyReportStatus.FAILED, reports.forDay(owner.id, today)?.status)
        assertEquals(1, reports.forDay(owner.id, today)?.generationAttempts)
    }

    @Test
    fun confirmedFailureAllowsOnlyOneBudgetedRetryAndOldMessageCannotRunNewGeneration() {
        val owner = account("job-retry")
        val today = LocalDate.now(java.time.ZoneId.of("Asia/Seoul"))
        reports.reserveScheduled(owner.id, today, input, 20)
        val firstId = reports.publishableJobs().single()
        reports.finishGenerationJob(firstId, requireNotNull(reports.claimGenerationJob(firstId)), null)
        assertTrue(reports.reserveScheduled(owner.id, today, input.copy(region = "부산"), 20).acquired)
        val secondId = reports.publishableJobs().single()
        assertNotEquals(firstId, secondId)
        assertNull(reports.claimGenerationJob(firstId))
        val second = requireNotNull(reports.claimGenerationJob(secondId))
        assertEquals(input, second.input)
        reports.finishGenerationJob(secondId, second, null)
        assertFalse(reports.reserveScheduled(owner.id, today, input, 20).acquired)
        assertEquals(2, reports.forDay(owner.id, today)?.generationAttempts)
    }

    private fun jobStatus(id: Long): String? = jdbc.queryForObject("SELECT status FROM daily_report_generation_job WHERE id = ?", String::class.java, id)
    private fun account(label: String): Account = accounts.createAccount(NewAccount("$label@daily-report.test", "hash", LocalDateTime.now()))
    private fun subscribed(label: String, hashChar: String): Account {
        val account = account(label)
        companies.createCompany(NewCompany(account.id, account.id.toString().padStart(10, '0'), "회사", "계속사업자", "01",
            CompanyProfileInput("서울", "정보통신업", 2020, null), LocalDateTime.now()))
        reports.reserveVerification(account.id, account.email, hashChar.repeat(64))
        assertTrue(reports.confirmEmail(hashChar.repeat(64)))
        reports.saveSettings(account.id, account.email, "AI", true, true)
        return account
    }
    private fun ready(owner: Account): DailyReport {
        val report = reports.reserve(owner.id, date, input, 20).report
        reports.succeed(report, DailyReportContent(listOf(item("BIZINFO")), emptyList()))
        return requireNotNull(reports.latest(owner.id))
    }
    private fun item(source: String) = DailyReportItem(source, "SAME_ID", "서울 AI 공고", "https://www.bizinfo.go.kr/detail?id=1",
        "상시 접수", 86, listOf("서울 AI 기술 지원"), "REVIEW_REQUIRED", "설립일 확인 필요", DailyReportEvidenceStatus.ANSWERED,
        "사업계획서 제출", listOf(DailyReportCitation("사업계획서", "https://www.bizinfo.go.kr/detail?id=1")))
}
