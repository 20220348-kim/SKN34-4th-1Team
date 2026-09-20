package ai.govbiz.core._common.test

import org.flywaydb.core.Flyway
import org.flywaydb.core.api.FlywayException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.core.io.support.PathMatchingResourcePatternResolver
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.testcontainers.mysql.MySQLContainer
import java.nio.file.Files
import java.nio.file.Path

/** 빈 DB와 기존 대화용 V19 DB를 실제 MySQL 8.4에서 검증합니다. 개발 DB·적용 이력은 변경하지 않습니다. */
class FlywayMigrationIntegrationTest {
    @Test
    fun demoSeedKeysPreserveUserWorkAndOnlyDeduplicateDemoRows() = withDatabase { mysql, jdbc ->
        migration(mysql, "34").migrate()
        jdbc.update("""INSERT INTO account (email, password_hash, terms_agreed_at)
            VALUES ('member@govbiz.local', 'test', NOW())""")
        val owner = jdbc.queryForObject("SELECT id FROM account WHERE email = 'member@govbiz.local'", Long::class.java)!!
        val insert = """INSERT INTO application_preparation
            (owner_account_id, source_code, source_program_id, form_version_id, service_field, created_at, updated_at)
            VALUES (?, 'BIZINFO', 'same-program', 'same-form', 'MARKETING', NOW(), NOW())"""
        jdbc.update(insert, owner)
        val before = jdbc.queryForMap("SELECT id, input_revision, created_at, updated_at FROM application_preparation")
        assertEquals(1, migration(mysql, "35").migrate().migrationsExecuted)
        assertEquals(before, jdbc.queryForMap("SELECT id, input_revision, created_at, updated_at FROM application_preparation"))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM application_preparation WHERE demo_seed_key IS NULL", Int::class.java))
        jdbc.update(insert, owner)
        jdbc.update(insert, owner)
        jdbc.update("UPDATE application_preparation SET demo_seed_key = 'demo-marketing-v1' WHERE id = ?", before["id"])
        assertThrows(org.springframework.dao.DuplicateKeyException::class.java) {
            jdbc.update("UPDATE application_preparation SET demo_seed_key = 'demo-marketing-v1' WHERE demo_seed_key IS NULL")
        }
        assertEquals(3, jdbc.queryForObject("SELECT COUNT(*) FROM application_preparation", Int::class.java))
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM application_preparation WHERE demo_seed_key IS NULL", Int::class.java))
    }

    @Test
    fun combinationReviewDemoSeedKeysAreUniquePerOwnerAndLeaveNullUserRowsUnlimited() = withDatabase { mysql, jdbc ->
        migration(mysql, "36").migrate()
        jdbc.update("""INSERT INTO account (email, password_hash, terms_agreed_at)
            VALUES ('member@govbiz.local', 'test', NOW()), ('second@test.local', 'test', NOW())""")
        val firstOwner = jdbc.queryForObject("SELECT id FROM account WHERE email = 'member@govbiz.local'", Long::class.java)!!
        val secondOwner = jdbc.queryForObject("SELECT id FROM account WHERE email = 'second@test.local'", Long::class.java)!!
        val insert = """INSERT INTO combination_review (owner_account_id, title, created_at, updated_at)
            VALUES (?, ?, NOW(), NOW())"""
        jdbc.update(insert, firstOwner, "기존 사용자 검토")
        val userReviewId = jdbc.queryForObject("SELECT id FROM combination_review WHERE title = '기존 사용자 검토'", Long::class.java)!!
        jdbc.update(insert, firstOwner, "진행 중인 지원사업과 신규 신청 중복 검토")
        val completedReviewId = jdbc.queryForObject("SELECT id FROM combination_review WHERE title = '진행 중인 지원사업과 신규 신청 중복 검토'", Long::class.java)!!
        jdbc.update("""INSERT INTO combination_review_run
            (review_id, input_revision, request_key, request_hash, status, input_json, evidence_json, configuration_json,
             analysis_json, runner_instance_id, started_at, finished_at, execution_started_at)
            VALUES (?, 1, '10000000-0000-4000-8000-000000000001', ?, 'SUCCEEDED', JSON_OBJECT(), JSON_OBJECT(),
                    JSON_OBJECT('model', 'demo-seed-no-paid-call'), JSON_OBJECT(),
                    '20000000-0000-4000-8000-000000000001', NOW(), NOW(), NOW())""", completedReviewId, "a".repeat(64))
        jdbc.update(insert, firstOwner, "마케팅·기술지원 사업 동시 신청 검토")
        val draftReviewId = jdbc.queryForObject("SELECT id FROM combination_review WHERE title = '마케팅·기술지원 사업 동시 신청 검토'", Long::class.java)!!
        jdbc.update("""INSERT INTO combination_review_program
            (review_id, position, source_code, source_program_id, application_submitted, selected,
             commitment_submitted, agreement_signed, execution_status, funding_received)
            VALUES
                (?, 0, 'BIZINFO', 'legacy-1', 'YES', 'UNKNOWN', 'NO', 'NO', 'NOT_STARTED', 'NO'),
                (?, 1, 'BIZINFO', 'legacy-2', 'NO', 'NO', 'NO', 'NO', 'NOT_STARTED', 'NO')""", draftReviewId, draftReviewId)
        val before = jdbc.queryForList("SELECT id, owner_account_id, title, input_revision, created_at, updated_at FROM combination_review ORDER BY id")

        assertEquals(1, migration(mysql, "37").migrate().migrationsExecuted)
        assertEquals(before, jdbc.queryForList("SELECT id, owner_account_id, title, input_revision, created_at, updated_at FROM combination_review ORDER BY id"))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review WHERE demo_seed_key IS NULL", Int::class.java))
        assertEquals("combination-review-completed-v1", jdbc.queryForObject("SELECT demo_seed_key FROM combination_review WHERE id = ?", String::class.java, completedReviewId))
        assertEquals("combination-review-draft-v1", jdbc.queryForObject("SELECT demo_seed_key FROM combination_review WHERE id = ?", String::class.java, draftReviewId))

        jdbc.update("UPDATE combination_review SET demo_seed_key = 'custom-demo-v1' WHERE id = ?", userReviewId)
        jdbc.update("""INSERT INTO combination_review
            (owner_account_id, demo_seed_key, title, created_at, updated_at)
            VALUES (?, 'custom-demo-v1', '다른 사용자 목업', NOW(), NOW())""", secondOwner)
        assertThrows(org.springframework.dao.DuplicateKeyException::class.java) {
            jdbc.update("""INSERT INTO combination_review
                (owner_account_id, demo_seed_key, title, created_at, updated_at)
                VALUES (?, 'custom-demo-v1', '중복 목업', NOW(), NOW())""", firstOwner)
        }
        jdbc.update(insert, firstOwner, "사용자 검토 2")
        jdbc.update(insert, firstOwner, "사용자 검토 3")

        assertEquals(6, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review", Int::class.java))
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review WHERE demo_seed_key IS NULL", Int::class.java))
    }

    @Test
    fun lexicalUpgradeOnlyInvalidatesDerivedReadinessAndPreservesPublishedHistory() = withDatabase { mysql, jdbc ->
        migration(mysql, "23").migrate()
        jdbc.update("""INSERT INTO support_program_sync_status
            (source_code, published_generation, published_catalog_fingerprint, published_program_count, index_ready,
             last_successful_sync_at, last_failed_sync_at, last_sync_outcome)
            VALUES ('BIZINFO', 7, ?, 1422, TRUE, '2026-09-06 10:00:00', '2026-09-07 10:00:00', 'FAILURE')""", "a".repeat(64))
        val columns = "source_code, published_generation, published_catalog_fingerprint, published_program_count, last_successful_sync_at, last_failed_sync_at, last_sync_outcome"
        val before = jdbc.queryForMap("SELECT $columns FROM support_program_sync_status")
        val history = jdbc.queryForList("SELECT version, script, checksum FROM flyway_schema_history ORDER BY installed_rank")
        val flyway = migration(mysql, "24")
        assertEquals(1, flyway.migrate().migrationsExecuted)
        assertEquals(before, jdbc.queryForMap("SELECT $columns FROM support_program_sync_status"))
        assertEquals(false, jdbc.queryForObject("SELECT index_ready FROM support_program_sync_status", Boolean::class.java))
        assertEquals(history, jdbc.queryForList("SELECT version, script, checksum FROM flyway_schema_history WHERE installed_rank <= 23 ORDER BY installed_rank"))
        jdbc.update("UPDATE support_program_sync_status SET index_ready = TRUE WHERE source_code = 'BIZINFO'")
        assertEquals(0, flyway.migrate().migrationsExecuted)
        assertEquals(true, jdbc.queryForObject("SELECT index_ready FROM support_program_sync_status", Boolean::class.java))
    }

    @Test
    fun freshDatabaseAppliesUniqueVersionsAndRepeatedStartupChangesNothing() = withDatabase { mysql, jdbc ->
        val flyway = migration(mysql, "21")
        assertEquals(21, flyway.migrate().migrationsExecuted)
        assertEquals(21, jdbc.queryForObject("SELECT COUNT(DISTINCT version) FROM flyway_schema_history WHERE success = 1", Int::class.java))
        assertEquals("V19__create_chat_conversation.sql", jdbc.queryForObject("SELECT script FROM flyway_schema_history WHERE version = '19'", String::class.java))
        assertEquals("V20__add_account_admin_management.sql", jdbc.queryForObject("SELECT script FROM flyway_schema_history WHERE version = '20'", String::class.java))
        assertEquals("V21__add_chat_conversation_deletion.sql", jdbc.queryForObject("SELECT script FROM flyway_schema_history WHERE version = '21'", String::class.java))
        assertEquals(0, flyway.migrate().migrationsExecuted)
        assertTrue(flyway.validateWithResult().validationSuccessful)
    }

    @Test
    fun upgradingAnAppliedChatV19PreservesItsHistoryAndExistingAccountChatAndCatalog() = withDatabase { mysql, jdbc ->
        migration(mysql, "19").migrate()
        val history = jdbc.queryForList("SELECT installed_rank, version, script, checksum, installed_on, success FROM flyway_schema_history ORDER BY installed_rank")
        assertEquals(-161548524, jdbc.queryForObject("SELECT checksum FROM flyway_schema_history WHERE version = '19'", Int::class.java))
        jdbc.update("INSERT INTO account (email, password_hash, terms_agreed_at) VALUES (?, ?, CURRENT_TIMESTAMP(6))", "preserved@test.local", "preserved-hash")
        val accountId = jdbc.queryForObject("SELECT id FROM account WHERE email = ?", Long::class.java, "preserved@test.local")!!
        val snapshot = """{"schemaVersion":1,"messages":[{"id":"preserved","role":"user","text":"서울 AI 지원 😀"}]}"""
        jdbc.update("INSERT INTO chat_conversation (account_id, conversation_id, title, snapshot, version, updated_at) VALUES (?, ?, ?, ?, 3, CURRENT_TIMESTAMP(6))",
            accountId, "preserved", "서울 AI 지원 😀", snapshot)
        jdbc.update("""INSERT INTO support_program (source_code, source_program_id, title, organization, summary, categories, regions,
            target_description, application_period_raw, source_url) VALUES ('BIZINFO', 'preserved', '한글 공고', '기관', '지원 요약',
            JSON_ARRAY('AI'), JSON_ARRAY('서울'), '중소기업', '상시', 'https://www.bizinfo.go.kr/')""")
        val account = jdbc.queryForMap("SELECT id, email, password_hash, terms_agreed_at FROM account WHERE id = ?", accountId)
        val chat = jdbc.queryForMap("SELECT id, account_id, conversation_id, title, CAST(snapshot AS CHAR) AS snapshot, version, updated_at FROM chat_conversation")
        val program = jdbc.queryForMap("SELECT id, title, summary, CAST(categories AS CHAR) AS categories, CAST(regions AS CHAR) AS regions, first_seen_at FROM support_program")

        val flyway = migration(mysql, "21")
        assertEquals(2, flyway.migrate().migrationsExecuted)
        assertEquals(history, jdbc.queryForList("SELECT installed_rank, version, script, checksum, installed_on, success FROM flyway_schema_history WHERE installed_rank <= 19 ORDER BY installed_rank"))
        assertEquals(account, jdbc.queryForMap("SELECT id, email, password_hash, terms_agreed_at FROM account WHERE id = ?", accountId))
        assertEquals(chat, jdbc.queryForMap("SELECT id, account_id, conversation_id, title, CAST(snapshot AS CHAR) AS snapshot, version, updated_at FROM chat_conversation"))
        assertEquals(program, jdbc.queryForMap("SELECT id, title, summary, CAST(categories AS CHAR) AS categories, CAST(regions AS CHAR) AS regions, first_seen_at FROM support_program"))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM chat_conversation WHERE deleted_at IS NULL", Int::class.java))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM account WHERE last_login_at IS NULL", Int::class.java))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM account_admin_action", Int::class.java))
        assertEquals(0, flyway.migrate().migrationsExecuted)
        assertTrue(flyway.validateWithResult().validationSuccessful)
    }

    @Test
    fun legacyAdminV19FailsSafelyAndTheDocumentedOneTimeReconciliationPreservesHistory(@TempDir legacy: Path) = withDatabase { mysql, jdbc ->
        // 이력 정합화는 격리된 테스트 DB에서만 재현합니다. 다른 개발자 DB를 자동 repair하지 않습니다.
        for (resource in PathMatchingResourcePatternResolver().getResources("classpath*:db/migration/V*.sql")) {
            val name = requireNotNull(resource.filename)
            val version = requireNotNull(Regex("^V(\\d+)__").find(name)).groupValues[1].toInt()
            if (version <= 18 || name == "V20__add_account_admin_management.sql") {
                resource.inputStream.use { Files.copy(it, legacy.resolve(if (version == 20) "V19__add_account_admin_management.sql" else name)) }
            }
        }
        Flyway.configure().dataSource(mysql.jdbcUrl, mysql.username, mysql.password)
            .locations("filesystem:$legacy").load().migrate()
        val original = jdbc.queryForMap("SELECT installed_rank, description, checksum, installed_on, success FROM flyway_schema_history WHERE version = '19'")
        assertThrows(FlywayException::class.java) { migration(mysql, "21").migrate() }
        assertEquals("V19__add_account_admin_management.sql", jdbc.queryForObject("SELECT script FROM flyway_schema_history WHERE version = '19'", String::class.java))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'chat_conversation'", Int::class.java))

        // 백업·스키마·체크섬을 확인한 DBA가 수행할 제한적인 이력 변경을 테스트합니다. 설치 순서와 시각은 보존합니다.
        assertEquals(1, jdbc.update("UPDATE flyway_schema_history SET version = '20', script = 'V20__add_account_admin_management.sql' WHERE version = '19' AND script = 'V19__add_account_admin_management.sql' AND checksum = ? AND success = 1", original["checksum"]))
        val reconciled = Flyway.configure().dataSource(mysql.jdbcUrl, mysql.username, mysql.password).target("21").outOfOrder(true).load()
        assertEquals(2, reconciled.migrate().migrationsExecuted)
        assertEquals(original, jdbc.queryForMap("SELECT installed_rank, description, checksum, installed_on, success FROM flyway_schema_history WHERE version = '20'"))
        assertTrue(migration(mysql, "21").validateWithResult().validationSuccessful)
        assertEquals(0, migration(mysql, "21").migrate().migrationsExecuted)
    }

    private fun migration(mysql: MySQLContainer, target: String) = Flyway.configure()
        .dataSource(mysql.jdbcUrl, mysql.username, mysql.password).target(target).load()

    private fun withDatabase(test: (MySQLContainer, JdbcTemplate) -> Unit) {
        MySQLContainer("mysql:8.4").withDatabaseName("govbiz_migration_test").use { mysql ->
            mysql.start()
            test(mysql, JdbcTemplate(DriverManagerDataSource(mysql.jdbcUrl, mysql.username, mysql.password)))
        }
    }
}
