package ai.govbiz.core.notification.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.domain.NewAccountSession
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.dailyreport.domain.DailyReportPushDevice
import ai.govbiz.core.dailyreport.repository.DailyReportPushRepository
import ai.govbiz.core.notification.domain.DeadlineReminderChannel
import ai.govbiz.core.notification.domain.DeadlineReminderOutcome
import ai.govbiz.core.notification.domain.DeadlineReminderSetting
import ai.govbiz.core.notification.domain.DeadlineReminderStatus
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
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
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

/** 알림 설정 UPSERT와 마감 알림의 한 번만 예약·선점·만료를 실제 MySQL 8.4에서 확인합니다. 메일·푸시는 호출하지 않습니다. */
@SpringBootTest(properties = ["app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false", "app.daily-report.enabled=false",
    "app.ai-service.base-url=http://127.0.0.1:1", "app.daily-report.push.enabled=false", "app.deadline-reminder.enabled=false"])
@Import(MySqlTestContainerConfig::class)
class DeadlineReminderRepositoryIntegrationTest {
    @Autowired private lateinit var reminders: DeadlineReminderRepository
    @Autowired private lateinit var settings: NotificationSettingsRepository
    @Autowired private lateinit var savedPrograms: SavedSupportProgramRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var push: DailyReportPushRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactions: PlatformTransactionManager
    private val seoul = ZoneId.of("Asia/Seoul")
    private val today get() = LocalDate.now(seoul)
    private val specialId = "공고-한글&특수/1 🧪"

    @BeforeEach
    fun clean() {
        jdbc.update("DELETE FROM account WHERE email LIKE '%@deadline-reminder.test'")
        jdbc.update("DELETE FROM support_program WHERE source_code IN ('REMINDTEST', 'REMINDOTHER')")
    }

    @Test
    fun settingsUpsertKeepsTheFirstEmailConsentAndTheDatabaseRejectsInvalidRows() {
        val owner = account("settings")
        assertEquals(DeadlineReminderSetting.DEFAULT, settings.deadlineReminder(owner.id))
        settings.saveDeadlineReminder(owner.id, DeadlineReminderSetting(enabled = true, email = true, push = false))
        val consentedAt = consent(owner)
        assertNotNull(consentedAt)
        val saved = settings.saveDeadlineReminder(owner.id, DeadlineReminderSetting(enabled = true, email = true, push = true))
        assertEquals(DeadlineReminderSetting(enabled = true, email = true, push = true), saved)
        assertEquals(consentedAt, consent(owner))
        settings.saveDeadlineReminder(owner.id, DeadlineReminderSetting(enabled = false, email = false, push = true))
        assertNull(consent(owner))

        val update = "UPDATE account_notification_setting SET %s WHERE account_id = ?"
        assertThrows(DataAccessException::class.java) { jdbc.update(update.format("deadline_reminder_enabled = TRUE, deadline_reminder_push = FALSE"), owner.id) }
        assertThrows(DataAccessException::class.java) { jdbc.update(update.format("deadline_reminder_email = TRUE"), owner.id) }

        assertThrows(IllegalStateException::class.java) {
            TransactionTemplate(transactions).executeWithoutResult {
                settings.saveDeadlineReminder(owner.id, DeadlineReminderSetting(enabled = true, email = false, push = true))
                error("rollback")
            }
        }
        assertEquals(DeadlineReminderSetting(enabled = false, email = false, push = true), settings.deadlineReminder(owner.id))
    }

    @Test
    fun onlyDueSavedProgramsOfEnabledActiveAccountsAreReservedOncePerDeadlineAndDay() {
        val owner = account("owner")
        val disabled = account("disabled")
        val suspended = account("suspended")
        val due = today.plusDays(3)
        program("REMINDTEST", specialId, due)
        program("REMINDOTHER", specialId, due)
        program("REMINDTEST", "later", due.plusDays(1))
        program("REMINDTEST", "hidden", due)
        program("REMINDTEST", "rolling", null)
        for (account in listOf(owner, disabled, suspended)) {
            for ((source, id) in listOf("REMINDTEST" to specialId, "REMINDOTHER" to specialId, "REMINDTEST" to "later",
                "REMINDTEST" to "hidden", "REMINDTEST" to "rolling")) {
                assertTrue(savedPrograms.saveIfPresent(account.id, source, id))
            }
        }
        jdbc.update("UPDATE support_program SET is_source_present = FALSE WHERE source_code = 'REMINDTEST' AND source_program_id = 'hidden'")
        settings.saveDeadlineReminder(owner.id, DeadlineReminderSetting(enabled = true, email = true, push = false))
        settings.saveDeadlineReminder(disabled.id, DeadlineReminderSetting(enabled = false, email = false, push = true))
        settings.saveDeadlineReminder(suspended.id, DeadlineReminderSetting(enabled = true, email = false, push = true))
        jdbc.update("UPDATE account SET suspended_at = NOW(6) WHERE id = ?", suspended.id)

        reminders.reserveDue(today)
        reminders.reserveDue(today)

        val rows = jdbc.queryForList("""SELECT account_id, source_code, source_program_id, kind, due_date, days_before, email_status, push_status
            FROM deadline_reminder WHERE account_id IN (?, ?, ?) ORDER BY source_code""", owner.id, disabled.id, suspended.id)
        assertEquals(listOf("REMINDOTHER", "REMINDTEST"), rows.map { it["source_code"] })
        rows.forEach { row ->
            assertEquals(owner.id, (row["account_id"] as Number).toLong())
            assertEquals(specialId, row["source_program_id"])
            assertEquals("DEADLINE", row["kind"])
            assertEquals(due.toString(), row["due_date"].toString())
            assertEquals(3, (row["days_before"] as Number).toInt())
            assertEquals("PENDING", row["email_status"])
            assertEquals("NOT_REQUESTED", row["push_status"])
        }
        assertThrows(DuplicateKeyException::class.java) {
            jdbc.update("""INSERT INTO deadline_reminder (account_id, source_code, source_program_id, kind, due_date, days_before,
                email_status, push_status, created_at) VALUES (?, 'REMINDTEST', ?, 'DEADLINE', ?, 3, 'PENDING', 'NOT_REQUESTED', NOW(6))""",
                owner.id, specialId, due)
        }

        // 마감일이 바뀐 공고는 새 마감일 기준의 별도 알림이 됩니다.
        jdbc.update("UPDATE support_program SET application_end_date = ? WHERE source_code = 'REMINDTEST' AND source_program_id = ?",
            due.plusDays(1), specialId)
        reminders.reserveDue(today.plusDays(1))
        assertEquals(listOf(due.toString(), due.plusDays(1).toString()), jdbc.queryForList(
            "SELECT due_date FROM deadline_reminder WHERE account_id = ? AND source_code = 'REMINDTEST' AND source_program_id = ? ORDER BY due_date",
            String::class.java, owner.id, specialId))
    }

    @Test
    fun eachSavedProgramIsReservedOnceAtSevenThreeAndOneDayBeforeItsDeadline() {
        val owner = account("schedule")
        val due = today.plusDays(7)
        program("REMINDTEST", "schedule", due)
        assertTrue(savedPrograms.saveIfPresent(owner.id, "REMINDTEST", "schedule"))
        settings.saveDeadlineReminder(owner.id, DeadlineReminderSetting(enabled = true, email = true, push = false))

        // 마감 7·3·1일 전에만 예약하고, 같은 날 다시 돌아도 일수마다 한 번뿐입니다.
        for (day in listOf(0L, 1L, 2L, 4L, 4L, 5L, 6L, 6L)) reminders.reserveDue(today.plusDays(day))

        assertEquals(listOf(7, 3, 1), jdbc.queryForList(
            "SELECT days_before FROM deadline_reminder WHERE account_id = ? ORDER BY days_before DESC", Int::class.java, owner.id))
        assertEquals(setOf(due.toString()), jdbc.queryForList(
            "SELECT due_date FROM deadline_reminder WHERE account_id = ?", String::class.java, owner.id).toSet())
        assertThrows(DuplicateKeyException::class.java) {
            jdbc.update("""INSERT INTO deadline_reminder (account_id, source_code, source_program_id, kind, due_date, days_before,
                email_status, push_status, created_at) VALUES (?, 'REMINDTEST', 'schedule', 'DEADLINE', ?, 3, 'PENDING', 'NOT_REQUESTED', NOW(6))""",
                owner.id, due)
        }
    }

    @Test
    fun claimedChannelIsNeverClaimedAgainAndStaleWorkExpiresWithoutResending() {
        val owner = account("claim")
        program("REMINDTEST", "claim", today.plusDays(1))
        program("REMINDTEST", "yesterday", today.plusDays(1))
        savedPrograms.saveIfPresent(owner.id, "REMINDTEST", "claim")
        savedPrograms.saveIfPresent(owner.id, "REMINDTEST", "yesterday")
        settings.saveDeadlineReminder(owner.id, DeadlineReminderSetting(enabled = true, email = true, push = true))
        reminders.reserveDue(today)
        val reminder = reminders.dispatchable(500).single { it.accountId == owner.id && it.sourceProgramId == "claim" }
        val stale = reminders.dispatchable(500).single { it.accountId == owner.id && it.sourceProgramId == "yesterday" }
        assertEquals(DeadlineReminderStatus.PENDING, reminder.emailStatus)
        assertEquals(DeadlineReminderStatus.PENDING, reminder.pushStatus)

        assertTrue(reminders.claim(reminder.id, DeadlineReminderChannel.EMAIL))
        assertFalse(reminders.claim(reminder.id, DeadlineReminderChannel.EMAIL))
        reminders.finish(reminder.id, DeadlineReminderChannel.EMAIL, DeadlineReminderOutcome.SENT)
        assertThrows(IllegalStateException::class.java) {
            reminders.finish(reminder.id, DeadlineReminderChannel.EMAIL, DeadlineReminderOutcome.unknown())
        }
        assertFalse(reminders.claim(reminder.id, DeadlineReminderChannel.EMAIL))

        assertTrue(reminders.claim(reminder.id, DeadlineReminderChannel.PUSH))
        jdbc.update("UPDATE deadline_reminder SET push_started_at = ? WHERE id = ?", LocalDateTime.now(seoul).minusMinutes(21), reminder.id)
        jdbc.update("UPDATE deadline_reminder SET created_at = ? WHERE id = ?", today.minusDays(1).atTime(9, 0), stale.id)
        assertFalse(reminders.claim(stale.id, DeadlineReminderChannel.EMAIL))
        reminders.expire()

        assertEquals(listOf("SENT", null, "UNKNOWN", "Expired"), status(reminder.id))
        assertEquals(listOf("SKIPPED", "Expired", "SKIPPED", "Expired"), status(stale.id))
        assertTrue(reminders.dispatchable(500).none { it.accountId == owner.id })
        reminders.reserveDue(today)
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM deadline_reminder WHERE account_id = ?", Int::class.java, owner.id))
    }

    @Test
    fun activeDevicesFollowTheDevicePermissionSessionAndUnregisteredTokens() {
        val owner = account("device")
        val deviceId = "b5b26378-977d-4ef1-8c02-66e8d25e8b83"
        val token = "ExpoPushToken[deadline_reminder_device]"
        accounts.createSession(owner.id, NewAccountSession("c".repeat(64), LocalDateTime.now(seoul).plusDays(1)))
        assertTrue(push.activeDevices(owner.id).isEmpty())
        push.register(deviceId, owner.id, "c".repeat(64), token)
        assertEquals(listOf(DailyReportPushDevice(deviceId, token)), push.activeDevices(owner.id))
        assertTrue(push.activeDevices(owner.id + 1).isEmpty())
        jdbc.update("UPDATE account_session SET expires_at = '2000-01-01' WHERE account_id = ?", owner.id)
        assertTrue(push.activeDevices(owner.id).isEmpty())
        jdbc.update("UPDATE account_session SET expires_at = '2100-01-01' WHERE account_id = ?", owner.id)
        push.invalidateToken(DailyReportPushDevice(deviceId, token))
        assertTrue(push.activeDevices(owner.id).isEmpty())
    }

    private fun account(label: String): Account =
        accounts.createAccount(NewAccount("$label@deadline-reminder.test", "hash", LocalDateTime.now(seoul)))

    private fun consent(owner: Account): LocalDateTime? = jdbc.queryForObject(
        "SELECT email_consented_at FROM account_notification_setting WHERE account_id = ?", LocalDateTime::class.java, owner.id)

    private fun status(id: Long): List<String?> = jdbc.queryForMap(
        "SELECT email_status, email_error, push_status, push_error FROM deadline_reminder WHERE id = ?", id,
    ).values.map { it as String? }

    private fun program(sourceCode: String, sourceProgramId: String, endDate: LocalDate?) {
        jdbc.update(
            """
            INSERT INTO support_program (
                source_code, source_program_id, title, organization, summary, categories, regions,
                target_description, application_period_raw, application_start_date, application_end_date, source_url
            ) VALUES (?, ?, 'AI 바우처 & 실증 지원사업', '정보통신산업진흥원', '실증 과제를 지원합니다.', '["기술"]', '["서울"]',
                '중소기업', ?, ?, ?, 'https://www.bizinfo.go.kr')
            """.trimIndent(),
            sourceCode, sourceProgramId, endDate?.let { "${it.minusDays(30)} ~ $it" } ?: "상시 접수",
            endDate?.minusDays(30), endDate,
        )
    }
}
