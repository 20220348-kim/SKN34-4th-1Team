package ai.govbiz.core.planusage.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.planusage.domain.PlanCode
import java.time.LocalDateTime
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate

/** 실제 MySQL 8.4에서 계정 요금제 배정 표(`account_plan`)의 조회·제약·계정 삭제 연쇄를 확인합니다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
    "app.application-document.jobs.enabled=false",
])
@Import(MySqlTestContainerConfig::class)
class PlanUsageRepositoryIntegrationTest {
    @Autowired private lateinit var repository: PlanUsageRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    private var ownerId = 0L

    @BeforeEach
    fun prepare() {
        ownerId = accounts.createAccount(
            NewAccount("plan-usage-${UUID.randomUUID()}@example.test", "test-password-hash", LocalDateTime.of(2026, 10, 1, 0, 0)),
        ).id
    }

    @Test
    fun readsFreeWithoutAnAssignmentAndTheAssignedPlanOtherwise() {
        assertEquals(PlanCode.FREE, repository.findPlan(ownerId))
        jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'PREMIUM', NOW(6))", ownerId)
        assertEquals(PlanCode.PREMIUM, repository.findPlan(ownerId))

        // 운영 문서의 배정 SQL은 다시 실행하면 요금제를 바꿉니다.
        jdbc.update("""INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'PLUS', NOW(6)) AS assigned
            ON DUPLICATE KEY UPDATE plan_code = assigned.plan_code, assigned_at = assigned.assigned_at""", ownerId)
        assertEquals(PlanCode.PLUS, repository.findPlan(ownerId))

        // 행을 지우면 FREE로 돌아갑니다.
        jdbc.update("DELETE FROM account_plan WHERE account_id = ?", ownerId)
        assertEquals(PlanCode.FREE, repository.findPlan(ownerId))
    }

    @Test
    fun theDatabaseRejectsUnknownPlans() {
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'GOLD', NOW(6))", ownerId)
        }
        // 대소문자를 구분하는 ascii_bin이라 소문자 코드도 받지 않습니다.
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'premium', NOW(6))", ownerId)
        }
        assertEquals(PlanCode.FREE, repository.findPlan(ownerId))
    }

    @Test
    fun deletingTheAccountRemovesItsPlan() {
        jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'PLUS', NOW(6))", ownerId)

        jdbc.update("DELETE FROM account WHERE id = ?", ownerId)

        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM account_plan WHERE account_id = ?", Int::class.java, ownerId))
    }
}
