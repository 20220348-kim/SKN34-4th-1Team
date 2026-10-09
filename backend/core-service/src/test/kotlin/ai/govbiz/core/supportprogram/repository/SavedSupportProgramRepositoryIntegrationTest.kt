package ai.govbiz.core.supportprogram.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.JdbcTemplate

/** 관심 공고 원문 선수집 outbox의 재대기 UPDATE가 바인딩한 LIMIT으로 오래된 행부터 정해진 수만 바꾸는지 실제 MySQL 8.4에서 확인합니다. */
@SpringBootTest(properties = ["app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false",
    "app.ai-service.base-url=http://127.0.0.1:1"])
@Import(MySqlTestContainerConfig::class)
class SavedSupportProgramRepositoryIntegrationTest {
    @Autowired private lateinit var savedPrograms: SavedSupportProgramRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    private val seoul = ZoneId.of("Asia/Seoul")

    @BeforeEach
    fun clean() {
        jdbc.update("DELETE FROM account WHERE email LIKE '%@saved-prefetch.test'")
        jdbc.update("DELETE FROM support_program WHERE source_code = 'SAVEDTEST'")
    }

    @Test
    fun requeueingStaleDonePrefetchMovesOnlyTheOldestBatchBackToPending() {
        val owner = accounts.createAccount(NewAccount("owner@saved-prefetch.test", "hash", LocalDateTime.now(seoul)))
        val staleIds = (0 until 52).map { index -> "stale-$index" }
        (staleIds + "fresh").forEach { id ->
            program(id)
            assertTrue(savedPrograms.saveIfPresent(owner.id, "SAVEDTEST", id))
        }
        staleIds.forEachIndexed { index, id ->
            markDone(id, LocalDateTime.of(2000, 1, 1, 0, 0).plusMinutes(index.toLong()))
        }
        markDone("fresh", LocalDateTime.now(seoul).minusHours(1))

        savedPrograms.expireStalePrefetch()

        val statuses = jdbc.queryForList(
            """
            SELECT program.source_program_id, saved.source_prefetch_status
            FROM saved_support_program saved
            JOIN support_program program ON program.id = saved.support_program_id
            WHERE program.source_code = 'SAVEDTEST'
            """.trimIndent(),
        ).associate { row -> row["source_program_id"] as String to row["source_prefetch_status"] as String }
        assertEquals(staleIds.take(50).toSet(), statuses.filterValues { it == "PENDING" }.keys)
        assertEquals(setOf("stale-50", "stale-51", "fresh"), statuses.filterValues { it == "DONE" }.keys)
    }

    private fun markDone(sourceProgramId: String, updatedAt: LocalDateTime) {
        jdbc.update(
            """
            UPDATE saved_support_program saved
            JOIN support_program program ON program.id = saved.support_program_id
            SET saved.source_prefetch_status = 'DONE', saved.source_prefetch_updated_at = ?
            WHERE program.source_code = 'SAVEDTEST' AND program.source_program_id = ?
            """.trimIndent(),
            updatedAt, sourceProgramId,
        )
    }

    private fun program(sourceProgramId: String) {
        jdbc.update(
            """
            INSERT INTO support_program (
                source_code, source_program_id, title, organization, summary, categories, regions,
                target_description, application_period_raw, source_url
            ) VALUES ('SAVEDTEST', ?, 'AI 바우처 & 실증 지원사업', '정보통신산업진흥원', '실증 과제를 지원합니다.', '["기술"]', '["서울"]',
                '중소기업', '상시 접수', 'https://www.bizinfo.go.kr')
            """.trimIndent(),
            sourceProgramId,
        )
    }
}
