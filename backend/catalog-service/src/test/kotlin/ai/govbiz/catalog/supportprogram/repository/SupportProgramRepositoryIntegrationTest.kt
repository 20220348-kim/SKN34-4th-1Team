package ai.govbiz.catalog.supportprogram.repository

import ai.govbiz.catalog._common.test.MySqlTestContainerConfig
import ai.govbiz.catalog.internal.config.CatalogInternalAuthFilter
import ai.govbiz.catalog.internal.controller.CatalogExceptionHandler
import ai.govbiz.catalog.internal.controller.CatalogSnapshotController
import ai.govbiz.catalog.internal.service.CatalogSnapshotService
import ai.govbiz.catalog.supportprogram.domain.*
import ai.govbiz.catalog.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.catalog.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import ai.govbiz.catalog.supportprogram.service.sync.*
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mockito
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate

/** 수집/AI는 스텁이며 DB·UPSERT·rollback·스냅샷 격리는 실제 MySQL 8.4에서 실행합니다. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = [
    "app.catalog.internal-token=catalog-test-token-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.kstartup.sync.enabled=false",
    "app.msit.sync.enabled=false", "app.cntrade-notice.sync.enabled=false",
    "app.support-program-index.enabled=false",
])
@Import(MySqlTestContainerConfig::class)
class SupportProgramRepositoryIntegrationTest {
    @Autowired private lateinit var repository: SupportProgramRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactionManager: PlatformTransactionManager
    @Autowired private lateinit var snapshotService: CatalogSnapshotService

    @BeforeEach
    fun clearCatalogOnly() {
        jdbc.update("DELETE FROM support_program")
        jdbc.update("DELETE FROM support_program_sync_status")
        jdbc.update("DELETE FROM support_program_sync_generation")
        jdbc.update("UPDATE catalog_source_revision SET revision = 0")
    }

    @ParameterizedTest
    @ValueSource(strings = ["BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE"])
    fun repeatedSyncDeactivatesOnlyMissingSourceProgramsAndFailureKeepsPublishedData(source: String) {
        val otherSource = if (source == "BIZINFO") "KSTARTUP" else "BIZINFO"
        val first = program("같은-ID", source)
        val removed = program("누락-ID", source)
        val other = program("같은-ID", otherSource)
        publish(otherSource, listOf(other))
        val index = Mockito.mock(SupportProgramIndexSyncService::class.java)
        var input = listOf(first, removed)
        val facade = SupportProgramCatalogFacade { input }
        fun sync() = when (source) {
            "BIZINFO" -> BizInfoSupportProgramCatalogSyncService(facade, repository, index).sync()
            "KSTARTUP" -> KStartupSupportProgramCatalogSyncService(facade, repository, index).sync()
            "MSIT" -> MsitSupportProgramCatalogSyncService(facade, repository, index).sync()
            else -> CnTradeNoticeSupportProgramCatalogSyncService(facade, repository, index).sync()
        }
        sync()
        input = listOf(first)
        repeat(2) { assertEquals(1, sync()) }
        val before = requireNotNull(repository.findSnapshot(source))
        assertEquals(listOf(first), before.programs)
        assertNull(repository.findPresentBySourceAndProgramId(source, removed.program.id))
        assertEquals(listOf(other), repository.findSnapshot(otherSource)?.programs)
        Mockito.doThrow(IllegalStateException("later index batch failed")).`when`(index).indexSnapshot(input)
        assertThrows(IllegalStateException::class.java) { sync() }
        val failed = requireNotNull(repository.findSnapshot(source))
        assertEquals(before.programs, failed.programs)
        assertEquals(before.status.publishedGeneration, failed.status.publishedGeneration)
        assertEquals(SupportProgramSyncOutcome.FAILURE, failed.status.lastSyncOutcome)
        assertTrue(failed.revision > before.revision)
        assertEquals(before.catalogId, failed.catalogId)
    }

    @Test
    fun roundTripsKoreanJsonNullableDatesStartupMetadataAndCompositeIdentities() {
        val first = program("공고-🚀", "BIZINFO").let {
            it.copy(program = it.program.copy(categories = listOf("AI", "기술 \"지원\""), regions = listOf("서울", "충남")))
        }
        val startup = program(first.program.id, "KSTARTUP").copy(
            startupDetails = SupportProgramStartupDetails(listOf("예비창업"), listOf("개인"), listOf("청년")),
        )
        publish("BIZINFO", listOf(first))
        publish("KSTARTUP", listOf(startup))
        assertEquals(first, repository.findSnapshot("BIZINFO")?.programs?.single())
        assertEquals(startup, repository.findSnapshot("KSTARTUP")?.programs?.single())
        val updated = first.copy(program = first.program.copy(title = "수정", applicationStartDate = LocalDate.of(2020, 1, 1)))
        publish("BIZINFO", listOf(updated))
        assertEquals(updated, repository.findSnapshot("BIZINFO")?.programs?.single())
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM support_program", Int::class.java))
    }

    @Test
    fun failedLaterBatchRollsBackCatalogStatusAndRevisionTogether() {
        val original = listOf(program("old", "BIZINFO"))
        publish("BIZINFO", original)
        val generation = repository.startSyncGeneration("BIZINFO")
        val before = repository.findSnapshot("BIZINFO")
        val invalid = (1..101).map { program("new-$it", "BIZINFO") }.toMutableList()
        invalid[100] = invalid[100].let { it.copy(program = it.program.copy(title = "x".repeat(501))) }
        assertThrows(DataAccessException::class.java) { repository.publishSnapshotIfCurrent("BIZINFO", invalid, generation) }
        assertEquals(before, repository.findSnapshot("BIZINFO"))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM support_program", Int::class.java))
    }

    @Test
    fun revisionTracksStatusOnlyChangesAndRejectsStalePublication() {
        publish("BIZINFO", listOf(program("one", "BIZINFO")))
        var snapshot = requireNotNull(repository.findSnapshot("BIZINFO"))
        val original = snapshot
        assertTrue(repository.markIndexNotReadyIfPublishedSnapshotMatches("BIZINFO",
            snapshot.status.publishedGeneration!!, snapshot.status.publishedCatalogFingerprint!!, 1))
        snapshot = requireNotNull(repository.findSnapshot("BIZINFO"))
        assertFalse(snapshot.status.indexReady)
        assertTrue(snapshot.revision > original.revision)
        assertEquals(original.programs, snapshot.programs)
        assertTrue(repository.markIndexReadyIfPublishedSnapshotMatches("BIZINFO",
            snapshot.status.publishedGeneration!!, snapshot.status.publishedCatalogFingerprint!!, 1))
        assertTrue(requireNotNull(repository.findSnapshot("BIZINFO")).revision > snapshot.revision)
        val oldGeneration = repository.startSyncGeneration("BIZINFO")
        val currentGeneration = repository.startSyncGeneration("BIZINFO")
        val current = repository.findSnapshot("BIZINFO")
        assertFalse(repository.publishSnapshotIfCurrent("BIZINFO", emptyList(), oldGeneration))
        assertFalse(repository.recordSyncFailureIfCurrent("BIZINFO", oldGeneration))
        assertEquals(current, repository.findSnapshot("BIZINFO"))
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", emptyList(), currentGeneration))
        val empty = requireNotNull(repository.findSnapshot("BIZINFO"))
        assertEquals(emptyList<CatalogSupportProgram>(), empty.programs)
        assertEquals(0, empty.status.publishedProgramCount)
        assertEquals(original.catalogId, empty.catalogId)
        UUID.fromString(empty.catalogId)
    }

    @Test
    fun repeatableReadKeepsProgramsStatusAndRevisionAtOneCommittedSnapshot() {
        publish("BIZINFO", listOf(program("old", "BIZINFO")))
        val transaction = TransactionTemplate(transactionManager).apply {
            isolationLevel = TransactionDefinition.ISOLATION_REPEATABLE_READ
            isReadOnly = true
        }
        val executor = Executors.newSingleThreadExecutor()
        try {
            transaction.execute {
                val before = repository.findSnapshot("BIZINFO")
                executor.submit { publish("BIZINFO", listOf(program("new", "BIZINFO"))) }.get(10, TimeUnit.SECONDS)
                assertEquals(before, repository.findSnapshot("BIZINFO"))
            }
        } finally {
            executor.shutdownNow()
        }
        assertEquals("new", repository.findSnapshot("BIZINFO")?.programs?.single()?.program?.id)
    }

    @Test
    fun standaloneMutationsAndLegacyBootstrapAdvanceRevisionWithoutPublishingUnverifiedData() {
        val item = program("one", "BIZINFO")
        assertNull(repository.findSnapshot("BIZINFO"))
        repository.upsert(item)
        assertEquals(1L, revision("BIZINFO"))
        assertNull(repository.findSnapshot("BIZINFO"))
        repository.synchronizeSource("BIZINFO", listOf(item))
        assertEquals(2L, revision("BIZINFO"))
        assertTrue(repository.bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", listOf(item)))
        assertEquals(3L, revision("BIZINFO"))
        assertNotNull(repository.findSnapshot("BIZINFO"))
        repository.upsert(item.copy(program = item.program.copy(title = "unpublished")))
        assertEquals(4L, revision("BIZINFO"))
        assertNull(repository.findSnapshot("BIZINFO"))
        assertEquals(0L, revision("KSTARTUP"))
    }

    @Test
    fun httpContractRequiresTokenExactSourceAndPublishedSnapshotWhileHealthOnlyReadsDatabase() {
        val mvc = MockMvcBuilders.standaloneSetup(CatalogSnapshotController(snapshotService))
            .setControllerAdvice(CatalogExceptionHandler())
            .addFilter<org.springframework.test.web.servlet.setup.StandaloneMockMvcBuilder>(CatalogInternalAuthFilter(TOKEN))
            .build()
        mvc.perform(get("/health")).andExpect(status().isOk)
        mvc.perform(get("/readiness")).andExpect(status().isOk)
        mvc.perform(get("/internal/v1/catalog/snapshots/BIZINFO")).andExpect(status().isUnauthorized)
        mvc.perform(get("/internal/v1/catalog/snapshots/BIZINFO").header("Authorization", "Bearer wrong"))
            .andExpect(status().isUnauthorized)
        mvc.perform(get("/internal/v1/catalog/snapshots/bizinfo").header("Authorization", "Bearer $TOKEN"))
            .andExpect(status().isBadRequest)
        mvc.perform(get("/internal/v1/catalog/snapshots/BIZINFO").header("Authorization", "Bearer $TOKEN"))
            .andExpect(status().isServiceUnavailable)
        repository.recordSyncFailureIfCurrent("BIZINFO", repository.startSyncGeneration("BIZINFO"))
        mvc.perform(get("/internal/v1/catalog/snapshots/BIZINFO").header("Authorization", "Bearer $TOKEN"))
            .andExpect(status().isServiceUnavailable)
        publish("BIZINFO", listOf(program("one", "BIZINFO")))
        mvc.perform(get("/internal/v1/catalog/snapshots/BIZINFO").header("Authorization", "Bearer $TOKEN"))
            .andExpect(status().isOk).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.schemaVersion").value(1))
            .andExpect(jsonPath("$.status.sourceCode").value("BIZINFO"))
            .andExpect(jsonPath("$.status.publishedProgramCount").value(1))
            .andExpect(jsonPath("$.programs[0].program.id").value("one"))
            .andExpect(jsonPath("$.programs[0].sortTimestamp").exists())
            .andExpect(jsonPath("$.programs[0].program.sourceQualifiedId").doesNotExist())
            .andExpect(jsonPath("$.programs[0].program.matchedReasons").doesNotExist())
            .andExpect(jsonPath("$.programs[0].program.recommendationScore").doesNotExist())
            .andExpect(jsonPath("$.programs[0].program.eligibilityReview").doesNotExist())
    }

    private fun publish(source: String, programs: List<CatalogSupportProgram>) {
        assertTrue(repository.publishSnapshotIfCurrent(source, programs, repository.startSyncGeneration(source)))
    }

    private fun program(id: String, source: String) = catalogProgram(id).let {
        it.copy(program = it.program.copy(sourceCode = source, sourceName = when (source) {
            "BIZINFO" -> "기업마당"
            "KSTARTUP" -> "K-Startup"
            "MSIT" -> "과학기술정보통신부"
            else -> "충청남도 온라인수출지원시스템"
        }))
    }

    private fun revision(source: String): Long = requireNotNull(jdbc.queryForObject(
        "SELECT revision FROM catalog_source_revision WHERE source_code = ?", Long::class.java, source,
    ))

    private companion object { const val TOKEN = "catalog-test-token-0123456789abcdef0123456789" }
}
