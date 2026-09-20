package ai.govbiz.core.supportprogram.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository
import ai.govbiz.core.supportprogram.domain.CatalogProjectionSnapshot
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncOutcome
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
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
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.ai-service.connect-timeout=10ms",
    "app.ai-service.read-timeout=10ms",
    "app.bizinfo.sync.enabled=false",
    "app.kstartup.sync.enabled=false",
    "app.msit.sync.enabled=false",
    "app.cntrade-notice.sync.enabled=false",
    "app.support-program-index.enabled=false",
])
@Import(MySqlTestContainerConfig::class)
class CatalogProjectionRepositoryIntegrationTest {
    @Autowired private lateinit var projection: CatalogProjectionRepository
    @Autowired private lateinit var programs: SupportProgramRepository
    @Autowired private lateinit var availability: ApplicationFormAvailabilityRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactions: PlatformTransactionManager

    @BeforeEach
    fun clearProjection() {
        jdbc.update("DELETE FROM account")
        jdbc.update("DELETE FROM application_form_availability")
        jdbc.update("DELETE FROM application_form_snapshot")
        jdbc.update("DELETE FROM support_program_source_document")
        jdbc.update("DELETE FROM support_program")
        jdbc.update("DELETE FROM support_program_sync_status")
        jdbc.update("DELETE FROM support_program_sync_generation")
        jdbc.update("DELETE FROM catalog_projection_checkpoint")
    }

    @Test
    fun appliesCompleteSnapshotAndRoundTripsKoreanJsonAndNullableDates() {
        val incoming = snapshot(listOf(program("한글-🚀")))
        assertFalse(projection.hasCheckpoints())

        assertTrue(projection.apply(incoming))

        val stored = requireNotNull(programs.findPresentBySourceAndProgramId("BIZINFO", "한글-🚀"))
        assertEquals(incoming.programs.single().program.title, stored.program.title)
        assertEquals(listOf("AI", "창업·수출"), stored.program.categories)
        assertEquals(listOf("서울", "전국"), stored.program.regions)
        assertNull(stored.program.applicationStartDate)
        assertNull(stored.program.applicationEndDate)
        assertEquals(incoming.status, programs.findSyncStatus("BIZINFO"))
        assertNotNull(availability.find("BIZINFO", "한글-🚀"))
        assertTrue(projection.hasCheckpoints())
        assertEquals(1L, revision())
    }

    @Test
    fun replayAndOlderRevisionLeaveRowsAndAnalysisRegistrationUntouched() {
        val incoming = snapshot(listOf(program("one")), revision = 4, generation = 3)
        projection.apply(incoming)
        val lastSeen = jdbc.queryForObject("SELECT last_seen_at FROM support_program", LocalDateTime::class.java)
        val analysis = jdbc.queryForMap("SELECT generation, next_retry_at FROM application_form_availability")

        assertFalse(projection.apply(incoming))
        assertFalse(projection.apply(snapshot(listOf(program("outdated")), revision = 2, generation = 1)))

        assertEquals(4L, revision())
        assertEquals(lastSeen, jdbc.queryForObject("SELECT last_seen_at FROM support_program", LocalDateTime::class.java))
        assertEquals(analysis, jdbc.queryForMap("SELECT generation, next_retry_at FROM application_form_availability"))
        assertNull(programs.findPresentBySourceAndProgramId("BIZINFO", "outdated"))
    }

    @Test
    fun rejectsSameRevisionPayloadChangesIncludingFieldsOutsideSearchFingerprint() {
        val incoming = snapshot(listOf(program("one")))
        projection.apply(incoming)
        val changedUrl = incoming.copy(programs = incoming.programs.map { it.copy(program = it.program.copy(sourceUrl = "https://example.com/changed")) })

        assertThrows(IllegalStateException::class.java) { projection.apply(changedUrl) }
        assertThrows(IllegalStateException::class.java) { projection.apply(incoming.copy(status = incoming.status.copy(indexReady = false))) }

        assertEquals("https://example.com/one", programs.findPresentBySourceAndProgramId("BIZINFO", "one")?.program?.sourceUrl)
        assertEquals(incoming.status, programs.findSyncStatus("BIZINFO"))
    }

    @Test
    fun dateDerivedStatusAndResponseEnrichmentDoNotInventAChangedRevision() {
        val incoming = snapshot(listOf(program("one"), program("two")))
        projection.apply(incoming)
        val refreshed = incoming.copy(programs = incoming.programs.reversed().map { it.copy(program = it.program.copy(
            status = SupportProgramStatus.CLOSED, sourceName = "응답 표시명", matchedReasons = listOf("화면용"), recommendationScore = 90,
        )) })
        assertFalse(projection.apply(refreshed))
    }

    @Test
    fun rejectsForeignCatalogInstanceAndGenerationReversalWithoutChangingCheckpoint() {
        val incoming = snapshot(listOf(program("one")), revision = 4, generation = 3)
        projection.apply(incoming)

        assertThrows(IllegalStateException::class.java) {
            projection.apply(incoming.copy(catalogId = OTHER_CATALOG, revision = 5))
        }
        assertThrows(IllegalStateException::class.java) {
            projection.apply(incoming.copy(revision = 5, status = incoming.status.copy(publishedGeneration = 2)))
        }

        assertEquals(4L, revision())
        assertEquals(incoming.status, programs.findSyncStatus("BIZINFO"))
    }

    @Test
    fun newerRevisionCannotChangeProgramsWithoutAdvancingTheirPublishedGeneration() {
        val incoming = snapshot(listOf(program("one")))
        projection.apply(incoming)
        val updated = snapshot(listOf(program("one", title = "변경된 내용")), revision = 2, generation = 1)
        assertThrows(IllegalStateException::class.java) { projection.apply(updated) }
        val changedUrl = incoming.copy(revision = 2, programs = incoming.programs.map {
            it.copy(program = it.program.copy(sourceUrl = "https://example.com/changed"))
        })
        assertThrows(IllegalStateException::class.java) { projection.apply(changedUrl) }
        assertEquals(1L, revision())
        assertEquals(incoming.status, programs.findSyncStatus("BIZINFO"))
    }

    @Test
    fun validatesFingerprintCountSourcesAndPublicationBeforeCreatingCheckpoint() {
        val incoming = snapshot(listOf(program("one")))
        val invalid = listOf(
            incoming.copy(status = incoming.status.copy(publishedCatalogFingerprint = "0".repeat(64))),
            incoming.copy(status = incoming.status.copy(publishedCatalogFingerprint = "invalid")),
            incoming.copy(status = incoming.status.copy(publishedProgramCount = 2)),
            incoming.copy(status = incoming.status.copy(publishedGeneration = null)),
            incoming.copy(status = incoming.status.copy(publishedGeneration = -1)),
            incoming.copy(status = incoming.status.copy(sourceCode = "UNKNOWN")),
            incoming.copy(revision = 0),
            incoming.copy(catalogId = "not-a-uuid"),
            snapshot(listOf(program("one", source = "MSIT"))),
            snapshot(listOf(program("one"), program("one"))),
            snapshot(List(20_001) { program("id-$it") }),
        )
        invalid.forEach { bad ->
            assertThrows(IllegalArgumentException::class.java) { projection.apply(bad) }
            assertFalse(projection.hasCheckpoints())
            assertEquals(0, count("support_program"))
            assertEquals(0, count("support_program_sync_status"))
            assertEquals(0, count("application_form_availability"))
        }
    }

    @Test
    fun rejectsCaseAndAccentCollisionsUsingTheExistingMysqlIdentityCollation() {
        listOf(listOf(program("Notice"), program("notice")), listOf(program("cafe"), program("café"))).forEach { colliding ->
            assertThrows(IllegalArgumentException::class.java) { projection.apply(snapshot(colliding)) }
            assertFalse(projection.hasCheckpoints())
            assertEquals(0, count("support_program"))
        }
    }

    @Test
    fun newerRevisionCanCopyIndexAndFailureStateWithoutChangingPublishedGeneration() {
        val incoming = snapshot(listOf(program("one")), generation = 5)
        projection.apply(incoming)
        val outage = incoming.copy(revision = 2, status = incoming.status.copy(
            indexReady = false, lastFailedSyncAt = OCCURRED_AT.plusHours(1), lastSyncOutcome = SupportProgramSyncOutcome.FAILURE,
        ))

        assertTrue(projection.apply(outage))
        assertEquals(outage.status, programs.findSyncStatus("BIZINFO"))
        assertTrue(programs.findSearchablePresent().isEmpty())
        assertEquals(1, programs.findPublishedPresent().size)

        val repaired = outage.copy(revision = 3, status = outage.status.copy(indexReady = true))
        assertTrue(projection.apply(repaired))
        assertEquals(repaired.status, programs.findSyncStatus("BIZINFO"))
        assertEquals(1, programs.findSearchablePresent().size)
    }

    @Test
    fun completeEmptySnapshotDeactivatesOnlyItsSourceAndIsStillPublished() {
        projection.apply(snapshot(listOf(program("shared"))))
        val other = snapshot(listOf(program("shared", source = "MSIT")), source = "MSIT")
        projection.apply(other)

        val empty = snapshot(emptyList(), revision = 2, generation = 2)
        assertTrue(projection.apply(empty))

        assertNull(programs.findPresentBySourceAndProgramId("BIZINFO", "shared"))
        assertNotNull(programs.findPresentBySourceAndProgramId("MSIT", "shared"))
        assertEquals(empty.status, programs.findSyncStatus("BIZINFO"))
        assertEquals(other.status, programs.findSyncStatus("MSIT"))
        assertEquals(1L, revision("MSIT"))
        assertEquals(2, count("support_program"))
    }

    @Test
    fun updatesAndReappearancePreserveNumericIdsAndSavedAndPartnerForeignKeys() {
        projection.apply(snapshot(listOf(program("Notice"))))
        val originalId = jdbc.queryForObject("SELECT id FROM support_program", Long::class.java)!!
        createSavedAndPartnerReferences(originalId)

        projection.apply(snapshot(listOf(program("notice", title = "갱신된 공고")), revision = 2, generation = 2))
        assertEquals(originalId, jdbc.queryForObject("SELECT id FROM support_program", Long::class.java))
        assertEquals("notice", programs.findPresentBySourceAndProgramId("BIZINFO", "Notice")?.program?.id)
        projection.apply(snapshot(emptyList(), revision = 3, generation = 3))
        assertEquals(1, count("saved_support_program"))
        assertEquals(1, count("partner_recruitment"))
        projection.apply(snapshot(listOf(program("NOTICE")), revision = 4, generation = 4))

        assertEquals(originalId, jdbc.queryForObject("SELECT id FROM support_program", Long::class.java))
        assertEquals(originalId, jdbc.queryForObject("SELECT support_program_id FROM saved_support_program", Long::class.java))
        assertEquals(originalId, jdbc.queryForObject("SELECT support_program_id FROM partner_recruitment", Long::class.java))
    }

    @Test
    fun laterBatchSqlFailureRollsBackDeactivationUpsertsAndTheFirstCheckpoint() {
        programs.upsert(program("existing"))
        val incoming = (0..100).map { program("new-$it", title = if (it == 100) "x".repeat(501) else "정상 공고") }

        assertThrows(DataAccessException::class.java) { projection.apply(snapshot(incoming)) }

        assertNotNull(programs.findPresentBySourceAndProgramId("BIZINFO", "existing"))
        assertEquals(1, count("support_program"))
        assertEquals(0, count("support_program_sync_status"))
        assertEquals(0, count("application_form_availability"))
        assertFalse(projection.hasCheckpoints())
    }

    @Test
    fun failureAfterRegistrationRollsBackProgramsStatusAvailabilityAndCheckpointTogether() {
        val initial = snapshot(listOf(program("existing")))
        projection.apply(initial)
        val beforeAvailability = jdbc.queryForMap("SELECT catalog_fingerprint, generation, status FROM application_form_availability")

        assertThrows(IllegalStateException::class.java) {
            TransactionTemplate(transactions).executeWithoutResult {
                projection.apply(snapshot(listOf(program("existing", title = "변경"), program("new")), revision = 2, generation = 2))
                assertNotNull(availability.find("BIZINFO", "new"))
                error("fail after every projection write")
            }
        }

        assertEquals(initial.programs.single().program.title, programs.findPresentBySourceAndProgramId("BIZINFO", "existing")?.program?.title)
        assertNull(programs.findPresentBySourceAndProgramId("BIZINFO", "new"))
        assertNull(availability.find("BIZINFO", "new"))
        assertEquals(beforeAvailability, jdbc.queryForMap("SELECT catalog_fingerprint, generation, status FROM application_form_availability"))
        assertEquals(initial.status, programs.findSyncStatus("BIZINFO"))
        assertEquals(1L, revision())
    }

    private fun revision(source: String = "BIZINFO"): Long = jdbc.queryForObject(
        "SELECT revision FROM catalog_projection_checkpoint WHERE source_code = ?", Long::class.java, source,
    )!!

    private fun count(table: String): Int = jdbc.queryForObject("SELECT COUNT(*) FROM $table", Int::class.java)!!

    private fun snapshot(
        items: List<CatalogSupportProgram>,
        source: String = "BIZINFO",
        revision: Long = 1,
        generation: Long = 1,
    ) = CatalogProjectionSnapshot(CATALOG, revision, SupportProgramSyncStatus(
        source, generation, SupportProgramCatalogFingerprintHelper.calculate(items), items.size, true,
        OCCURRED_AT, null, SupportProgramSyncOutcome.SUCCESS,
    ), items)

    private fun program(id: String, source: String = "BIZINFO", title: String = "서울 \"AI\" 지원 🚀") = CatalogSupportProgram(
        SupportProgram(id, source, title, "지원기관", "한글 요약 & 특수문자", listOf("AI", "창업·수출"), listOf("서울", "전국"),
            "중소기업", "공고문 참고", null, null, SupportProgramStatus.UNKNOWN, "기업마당", "https://example.com/$id", emptyList()),
        "20260919",
    )

    private fun createSavedAndPartnerReferences(programId: Long) {
        jdbc.update("""
            INSERT INTO account (email, password_hash, terms_agreed_at) VALUES ('projection@example.com', 'test', NOW())
        """.trimIndent())
        val accountId = jdbc.queryForObject("SELECT id FROM account WHERE email = 'projection@example.com'", Long::class.java)!!
        jdbc.update("""
            INSERT INTO company (account_id, business_number, company_name, business_status, business_status_code,
                region, industry, founded_year, business_verified_at, created_at, updated_at)
            VALUES (?, '1234567890', '테스트 기업', '계속사업자', '01', '서울', 'IT', 2020, NOW(), NOW(), NOW())
        """.trimIndent(), accountId)
        val companyId = jdbc.queryForObject("SELECT id FROM company WHERE account_id = ?", Long::class.java, accountId)!!
        jdbc.update("INSERT INTO saved_support_program (account_id, support_program_id, saved_at) VALUES (?, ?, NOW())", accountId, programId)
        jdbc.update("""
            INSERT INTO partner_recruitment (account_id, company_id, support_program_id, title, body, own_role,
                seeking_role, seeking_count, region, capabilities, recruitment_deadline, created_at, updated_at)
            VALUES (?, ?, ?, '협업 모집', '본문', 'MANUFACTURING', 'MARKETING', 1, '서울', JSON_ARRAY(), '2099-12-31', NOW(), NOW())
        """.trimIndent(), accountId, companyId, programId)
    }

    private companion object {
        const val CATALOG = "555b6a2e-0b0f-4a91-88bd-59449392c821"
        const val OTHER_CATALOG = "aa9b4c46-e0fb-46b0-b2df-bf52e8f4ad4a"
        val OCCURRED_AT: LocalDateTime = LocalDateTime.of(2026, 9, 19, 10, 0)
    }
}
