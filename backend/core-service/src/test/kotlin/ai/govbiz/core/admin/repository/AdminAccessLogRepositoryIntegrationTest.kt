package ai.govbiz.core.admin.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccessLogQuery
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.domain.NewAdminAccessLog
import java.time.LocalDate
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate

/**
 * 관리자 접속기록 테이블과 조치 종류 확장(V49)을 실제 MySQL 8.4에서 확인합니다. 한글·이모지·마이크로초 시각의 왕복,
 * 최신순 커서, 서울 날짜 기간(끝 날 포함), 계정 행이 없어져도 남는 기록과 DB CHECK 제약을 봅니다.
 */
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
class AdminAccessLogRepositoryIntegrationTest {

    @Autowired
    private lateinit var repository: AdminAccessLogRepository

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @BeforeEach
    fun reset() {
        // 애플리케이션은 기록을 지우지 않지만 테스트끼리 섞이지 않도록 격리된 테스트 DB에서만 비웁니다.
        jdbcTemplate.update("DELETE FROM admin_access_log")
        jdbcTemplate.update("DELETE FROM account_admin_action")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
    }

    @Test
    fun storesKoreanEmojiAndMicrosecondsAndReadsNewestFirstWithACursor() {
        val adminId = insertAccount("admin@govbiz.local", "ADMIN")
        val actor = AdminActor(adminId, "2001:db8::7", "Mozilla/5.0 한글 브라우저 😀")
        repository.insert(NewAdminAccessLog(actor, AdminAccessAction.ACCOUNT_LIST, null, "keywordLength=3, sort=RECENT, page=1, pageSize=20, returned=0", at(1, 9)))
        repository.insert(NewAdminAccessLog(actor, AdminAccessAction.ACCOUNT_DETAIL, 11, null, at(2, 9)))
        repository.insert(NewAdminAccessLog(actor, AdminAccessAction.ACCOUNT_SUSPEND, 11, "adminActionId=31", at(3, 9).withNano(123_456_000)))

        val first = repository.findPage(query(limit = 2))

        assertEquals(listOf(AdminAccessAction.ACCOUNT_SUSPEND, AdminAccessAction.ACCOUNT_DETAIL), first.records.map { it.action })
        assertEquals(first.records.last().id, first.nextCursor)
        val newest = first.records.first()
        assertEquals(adminId, newest.actorAccountId)
        assertEquals("admin@govbiz.local", newest.actorEmail)
        assertEquals(11L, newest.targetAccountId)
        assertEquals("adminActionId=31", newest.requestSummary)
        assertEquals("2001:db8::7", newest.clientIp)
        assertEquals("Mozilla/5.0 한글 브라우저 😀", newest.userAgent)
        assertEquals(at(3, 9).withNano(123_456_000), newest.createdAt)

        val second = repository.findPage(query(limit = 2, before = first.nextCursor))
        val oldest = second.records.single()
        assertEquals(AdminAccessAction.ACCOUNT_LIST, oldest.action)
        assertNull(oldest.targetAccountId)
        assertNull(second.nextCursor)
    }

    @Test
    fun filtersByActorTargetActionAndAnInclusiveSeoulDateRange() {
        val first = AdminActor(insertAccount("first@govbiz.local", "ADMIN"), "198.51.100.1", null)
        val second = AdminActor(insertAccount("second@govbiz.local", "ADMIN"), "198.51.100.2", null)
        repository.insert(NewAdminAccessLog(first, AdminAccessAction.ACCOUNT_LIST, null, "returned=0", LocalDateTime.of(2026, 8, 31, 23, 59, 59)))
        repository.insert(NewAdminAccessLog(first, AdminAccessAction.ACCOUNT_DETAIL, 11, null, LocalDateTime.of(2026, 9, 1, 0, 0)))
        repository.insert(NewAdminAccessLog(second, AdminAccessAction.ACCOUNT_DETAIL, 12, null, LocalDateTime.of(2026, 9, 6, 23, 59, 59, 999_999_000)))
        repository.insert(NewAdminAccessLog(second, AdminAccessAction.ACCOUNT_DETAIL, 11, null, LocalDateTime.of(2026, 9, 7, 0, 0)))

        fun targets(query: AdminAccessLogQuery) = repository.findPage(query).records.map { it.targetAccountId }

        assertEquals(listOf(12L, 11L), targets(query(from = LocalDate.of(2026, 9, 1), to = LocalDate.of(2026, 9, 6))))
        assertEquals(listOf(11L, 12L), targets(query(actorAccountId = second.accountId)))
        assertEquals(listOf(11L, 11L), targets(query(targetAccountId = 11)))
        assertEquals(listOf<Long?>(null), targets(query(action = AdminAccessAction.ACCOUNT_LIST)))
        assertEquals(listOf(11L), targets(query(actorAccountId = first.accountId, targetAccountId = 11)))
        // 시작일이 종료일보다 늦으면 맞는 기록이 없습니다.
        assertEquals(emptyList<Long?>(), targets(query(from = LocalDate.of(2026, 9, 6), to = LocalDate.of(2026, 9, 1))))
    }

    @Test
    fun recordsOutliveTheirAccountRowsAndTheDatabaseRejectsUnknownActions() {
        val adminId = insertAccount("gone@govbiz.local", "ADMIN")
        val memberId = insertAccount("member@company.co.kr", "USER")
        repository.insert(NewAdminAccessLog(AdminActor(adminId, "198.51.100.7", null), AdminAccessAction.ACCOUNT_DETAIL, memberId, null, at(1, 9)))

        // 외래 키가 없으므로 계정 행을 직접 지워도 기록과 대상 ID는 그대로 남고, 처리자 이메일만 비어 보입니다.
        jdbcTemplate.update("DELETE FROM account")
        val kept = repository.findPage(query()).records.single()
        assertEquals(adminId, kept.actorAccountId)
        assertEquals(memberId, kept.targetAccountId)
        assertNull(kept.actorEmail)

        assertThrows(DataAccessException::class.java) {
            jdbcTemplate.update(
                "INSERT INTO admin_access_log (actor_account_id, action, client_ip, created_at) VALUES (?, 'ACCOUNT_DELETE', '::1', NOW(6))",
                adminId,
            )
        }
        assertThrows(DataAccessException::class.java) {
            jdbcTemplate.update(
                "INSERT INTO admin_access_log (actor_account_id, action, client_ip, created_at) VALUES (?, 'ACCOUNT_LIST', '', NOW(6))",
                adminId,
            )
        }
    }

    @Test
    fun adminActionRecordsAcceptRoleGrantsAndRevokesAfterV49() {
        val adminId = insertAccount("admin@govbiz.local", "ADMIN")
        val memberId = insertAccount("member@company.co.kr", "USER")
        val insert = "INSERT INTO account_admin_action (target_account_id, admin_account_id, action, reason, created_at) VALUES (?, ?, ?, '권한 변경 사유', NOW(6))"

        jdbcTemplate.update(insert, memberId, adminId, "ADMIN_GRANT")
        jdbcTemplate.update(insert, memberId, adminId, "ADMIN_REVOKE")

        assertEquals(2, jdbcTemplate.queryForObject("SELECT COUNT(*) FROM account_admin_action", Int::class.java))
        assertThrows(DataAccessException::class.java) { jdbcTemplate.update(insert, memberId, adminId, "ROLE_CHANGE") }
    }

    private fun insertAccount(email: String, role: String): Long {
        jdbcTemplate.update(
            "INSERT INTO account (email, password_hash, role, terms_agreed_at, created_at) VALUES (?, 'test-hash', ?, NOW(6), NOW(6))",
            email,
            role,
        )
        return requireNotNull(jdbcTemplate.queryForObject("SELECT id FROM account WHERE email = ?", Long::class.java, email))
    }

    private fun at(day: Int, hour: Int): LocalDateTime = LocalDateTime.of(2026, 9, day, hour, 0)

    private fun query(
        actorAccountId: Long? = null,
        targetAccountId: Long? = null,
        action: AdminAccessAction? = null,
        from: LocalDate? = null,
        to: LocalDate? = null,
        before: Long? = null,
        limit: Int = AdminAccessLogQuery.MAX_LIMIT,
    ) = AdminAccessLogQuery(actorAccountId, targetAccountId, action, from, to, before, limit)
}
