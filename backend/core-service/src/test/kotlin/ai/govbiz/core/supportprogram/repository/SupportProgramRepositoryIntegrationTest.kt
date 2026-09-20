package ai.govbiz.core.supportprogram.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramStartupDetails
import ai.govbiz.core.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.core.supportprogram.service.sync.KStartupSupportProgramCatalogSyncService
import ai.govbiz.core.supportprogram.service.sync.MsitSupportProgramCatalogSyncService
import ai.govbiz.core.supportprogram.service.sync.CnTradeNoticeSupportProgramCatalogSyncService
import ai.govbiz.core.supportprogram.service.sync.SupportProgramIndexSyncService
import ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogSyncOnceService
import ai.govbiz.core.supportprogram.service.sync.config.SupportProgramCatalogSyncOnceProperties
import java.math.BigDecimal
import java.nio.file.Path
import org.junit.jupiter.api.io.TempDir
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncOutcome
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.time.LocalDate
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
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

@SpringBootTest(
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.ai-service.connect-timeout=10ms",
        "app.ai-service.read-timeout=10ms",
        "app.bizinfo.sync.enabled=false",
        "app.kstartup.sync.enabled=false",
        "app.msit.sync.enabled=false",
        "app.cntrade-notice.sync.enabled=false",
        "app.support-program-index.enabled=false",
    ],
)
@Import(MySqlTestContainerConfig::class)
class SupportProgramRepositoryIntegrationTest {

    @TempDir
    lateinit var syncOnceDirectory: Path

    @Test
    fun oneShotSyncPreservesOtherSourcesIsIdempotentAndKeepsOldSnapshotOnIndexFailure() {
        val original = catalogProgram("shared", "한글 공고 🚀")
        val removed = catalogProgram("removed", "누락될 공고")
        val other = catalogProgram("shared", "다른 제공처", sourceCode = "KSTARTUP")
        repository.synchronizeSource("BIZINFO", listOf(original, removed))
        repository.upsert(other)
        var snapshot = listOf(original)
        val index = Mockito.mock(SupportProgramIndexSyncService::class.java)
        Mockito.`when`(index.indexSnapshot(snapshot)).thenReturn(1)
        val unused = SupportProgramCatalogFacade { error("unselected source called") }
        val service = SupportProgramCatalogSyncOnceService(SupportProgramCatalogFacade { snapshot }, unused, unused, unused, repository, index, publicationService)
        repeat(2) { attempt ->
            service.run(SupportProgramCatalogSyncOnceProperties(listOf("BIZINFO"), BigDecimal.ONE,
                syncOnceDirectory.resolve("approved-$attempt"), true))
            assertEquals(original, repository.findSearchablePresent().single())
            assertFalse(isSourcePresent("BIZINFO", "removed"))
            assertEquals(other, repository.findPresentBySourceAndProgramId("KSTARTUP", "shared"))
        }
        snapshot = listOf(original.copy(program = original.program.copy(title = "아직 공개하지 않음")))
        Mockito.`when`(index.indexSnapshot(snapshot)).thenThrow(IllegalStateException("later batch failed"))
        assertThrows(IllegalStateException::class.java) {
            service.run(SupportProgramCatalogSyncOnceProperties(listOf("BIZINFO"), BigDecimal.ONE,
                syncOnceDirectory.resolve("approved-failure"), true))
        }
        assertEquals(original, repository.findSearchablePresent().single())
        assertEquals(other, repository.findPresentBySourceAndProgramId("KSTARTUP", "shared"))
        assertEquals(SupportProgramSyncOutcome.FAILURE, repository.findSyncStatus("BIZINFO")?.lastSyncOutcome)
    }

    @Autowired private lateinit var publicationService: ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogPublicationService
    @Autowired
    private lateinit var repository: SupportProgramRepository

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @Autowired
    private lateinit var supportProgramSearchService: SupportProgramSearchService

    @BeforeEach
    fun deleteSupportPrograms() {
        jdbcTemplate.update("DELETE FROM support_program_source_document")
        jdbcTemplate.update("DELETE FROM support_program")
        jdbcTemplate.update("DELETE FROM support_program_sync_status")
        jdbcTemplate.update("DELETE FROM support_program_sync_generation")
    }

    @Test
    fun synchronizesLargeSnapshotsInOrderAcrossBatchBoundaries() {
        val programs = (0 until 205).map { index ->
            catalogProgram(
                id = "PBLN_BATCH_${index.toString().padStart(3, '0')}",
                title = "서울 \"AI\" 지원 $index",
                categories = listOf("AI", "창업·수출"),
                regions = listOf("서울", "전국"),
                applicationPeriod = "상시 접수",
                applicationStartDate = null,
                applicationEndDate = null,
            )
        }
        val sameBatchUpdate = programs[0].copy(program = programs[0].program.copy(title = "같은 배치의 최종 값"))
        val laterBatchUpdate = programs[1].copy(program = programs[1].program.copy(title = "다음 배치의 최종 값"))
        val otherSource = catalogProgram(programs[0].program.id, "다른 제공처 공고", sourceCode = "KSTARTUP")
        repository.upsert(otherSource)
        repository.upsert(catalogProgram("PBLN_STALE", "목록에서 사라진 공고"))
        val snapshot = programs.take(2) + sameBatchUpdate + programs.drop(2) + laterBatchUpdate
        val expected = listOf(sameBatchUpdate, laterBatchUpdate) + programs.drop(2)

        repeat(2) {
            repository.synchronizeSource("BIZINFO", snapshot)

            assertEquals(expected, repository.findPresent().filter { it.program.sourceCode == "BIZINFO" })
            assertEquals(205, countPresentRows("BIZINFO"))
            assertEquals(206, countRows("BIZINFO"))
            assertFalse(isSourcePresent("BIZINFO", "PBLN_STALE"))
            assertEquals(otherSource, repository.findPresentBySourceAndProgramId("KSTARTUP", programs[0].program.id))
        }
    }

    @Test
    fun roundTripsStartupMetadataAndClearsItOnUpsertWithoutTouchingBizinfo() {
        val bizinfo = catalogProgram("shared", "기업마당 공고")
        val startup = catalogProgram("shared", "창업 \"특수\" 공고 🚀", sourceCode = "KSTARTUP",
            applicationPeriod = "기간 미정", applicationStartDate = null, applicationEndDate = null)
            .let { it.copy(program = it.program.copy(status = SupportProgramStatus.UNKNOWN)) }
            .copy(startupDetails = SupportProgramStartupDetails(listOf("예비창업자", "3년미만"), listOf("대학·연구기관", "한글 \"대상\""), emptyList()))
        repository.upsert(bizinfo)
        repository.upsert(startup)

        assertEquals(startup, repository.findPresentBySourceAndProgramId("KSTARTUP", "shared"))
        assertEquals(bizinfo, repository.findPresentBySourceAndProgramId("BIZINFO", "shared"))
        val noDetails = startup.copy(startupDetails = null)
        repository.upsert(noDetails)
        assertEquals(noDetails, repository.findPresentBySourceAndProgramId("KSTARTUP", "shared"))
        assertEquals(1, countRowsByProgramId("KSTARTUP", "shared"))
    }

    @Test
    fun startupSnapshotIsIdempotentAndDeactivatesOnlyMissingStartupNotices() {
        val first = catalogProgram("same", "창업 공고", sourceCode = "KSTARTUP")
            .copy(startupDetails = SupportProgramStartupDetails(listOf("3년미만"), listOf("일반기업"), listOf("만 40세 이상")))
        val removed = catalogProgram("removed", "이전 공고", sourceCode = "KSTARTUP")
        val bizinfo = catalogProgram("same", "기업마당 별도 공고")
        repository.upsert(bizinfo)
        repository.synchronizeSource("KSTARTUP", listOf(first, removed))
        val index = Mockito.mock(SupportProgramIndexSyncService::class.java)
        val service = KStartupSupportProgramCatalogSyncService(SupportProgramCatalogFacade { listOf(first) }, repository, index, publicationService)

        repeat(2) {
            assertEquals(1, service.sync())
            assertEquals(first, repository.findPublishedPresent().single())
            assertEquals(first, repository.findSearchablePresent().single())
            assertFalse(isSourcePresent("KSTARTUP", "removed"))
            assertEquals(bizinfo, repository.findPresentBySourceAndProgramId("BIZINFO", "same"))
            assertEquals(2, countRows("KSTARTUP"))
        }
    }

    @Test
    fun startupCollectionAndIndexFailuresKeepThePreviousPublishedSnapshot() {
        val original = catalogProgram("original", "기존 창업 공고", sourceCode = "KSTARTUP")
            .copy(startupDetails = SupportProgramStartupDetails(listOf("예비창업자"), listOf("일반인"), emptyList()))
        val generation = repository.startSyncGeneration("KSTARTUP")
        repository.publishSnapshotIfCurrent("KSTARTUP", listOf(original), generation)
        val bizinfo = catalogProgram("original", "기업마당 공고")
        repository.upsert(bizinfo)
        val index = Mockito.mock(SupportProgramIndexSyncService::class.java)
        val collectionFailure = KStartupSupportProgramCatalogSyncService(
            SupportProgramCatalogFacade { throw IllegalStateException("second page failed") }, repository, index, publicationService)
        assertThrows(IllegalStateException::class.java) { collectionFailure.sync() }
        Mockito.verifyNoInteractions(index)

        val next = listOf(original.copy(program = original.program.copy(title = "아직 공개하면 안 되는 공고")))
        Mockito.`when`(index.indexSnapshot(next)).thenThrow(IllegalStateException("second index batch failed"))
        val indexFailure = KStartupSupportProgramCatalogSyncService(SupportProgramCatalogFacade { next }, repository, index, publicationService)
        assertThrows(IllegalStateException::class.java) { indexFailure.sync() }

        assertEquals(listOf(original), repository.findPublishedPresent())
        assertEquals(listOf(original), repository.findSearchablePresent())
        assertEquals(bizinfo, repository.findPresentBySourceAndProgramId("BIZINFO", "original"))
        assertEquals(SupportProgramSyncOutcome.FAILURE, repository.findSyncStatus("KSTARTUP")?.lastSyncOutcome)
    }

    @Test
    fun startupBatchRollbackRestoresOldRowsAndMetadataWhenALaterBatchFails() {
        val original = catalogProgram("original", "기존 창업 공고", sourceCode = "KSTARTUP")
            .copy(startupDetails = SupportProgramStartupDetails(listOf("7년미만"), listOf("일반기업"), emptyList()))
        repository.synchronizeSource("KSTARTUP", listOf(original))
        val valid = (1..100).map { catalogProgram("new-$it", "새 공고", sourceCode = "KSTARTUP") }
        val invalid = catalogProgram("invalid", "가".repeat(501), sourceCode = "KSTARTUP")

        assertThrows(DataAccessException::class.java) { repository.synchronizeSource("KSTARTUP", valid + invalid) }

        assertEquals(listOf(original), repository.findPresent())
        assertEquals(1, countRows("KSTARTUP"))
    }

    @Test
    fun databaseRejectsStartupMetadataOnAnotherSource() {
        val wrongSource = catalogProgram("wrong", "잘못된 제공처 메타데이터")
            .copy(startupDetails = SupportProgramStartupDetails(emptyList(), emptyList(), emptyList()))

        assertThrows(DataAccessException::class.java) { repository.upsert(wrongSource) }
        assertTrue(repository.findPresent().isEmpty())
    }

    @Test
    fun storesAndReadsKoreanArraysAndNullableDates() {
        val catalogProgram = catalogProgram(
            id = "PBLN_JSON",
            title = "서울 \"AI\" 기업 지원",
            categories = listOf("AI", "창업"),
            regions = listOf("서울", "전국"),
            applicationPeriod = "상시 접수",
            applicationStartDate = null,
            applicationEndDate = null,
        )

        repository.upsert(catalogProgram)

        val stored = requireNotNull(repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_JSON"))

        assertEquals(catalogProgram, stored)
        assertNull(stored.program.applicationStartDate)
        assertNull(stored.program.applicationEndDate)
    }

    @Test
    fun storesAndReadsEmptyArraysAndBlankSortTimestamp() {
        val catalogProgram = catalogProgram(
            id = "PBLN_EMPTY",
            title = "빈 분류 공고",
            categories = emptyList(),
            regions = emptyList(),
            applicationPeriod = "상시 접수",
            applicationStartDate = null,
            applicationEndDate = null,
        ).copy(sortTimestamp = "")

        repository.upsert(catalogProgram)

        assertEquals(
            catalogProgram,
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_EMPTY"),
        )
    }

    @Test
    fun upsertsTheSameBizInfoIdWithoutCreatingAnotherRow() {
        repository.upsert(
            catalogProgram(
                id = "PBLN_UPSERT",
                title = "변경 전 공고",
                categories = listOf("AI"),
                regions = listOf("서울"),
                applicationPeriod = "2000-01-01 ~ 9999-12-31",
                applicationStartDate = LocalDate.of(2000, 1, 1),
                applicationEndDate = LocalDate.of(9999, 12, 31),
            ),
        )
        val updated = catalogProgram(
            id = "PBLN_UPSERT",
            title = "변경 후 공고",
            categories = listOf("AI", "수출"),
            regions = listOf("서울", "경기"),
            applicationPeriod = "2001-01-01 ~ 9999-12-31",
            applicationStartDate = LocalDate.of(2001, 1, 1),
            applicationEndDate = LocalDate.of(9999, 12, 31),
        )

        repository.upsert(updated)

        assertEquals(
            updated,
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_UPSERT"),
        )
    }

    @Test
    fun preservesTheLatestSourceProgramIdCasingWhenUpsertingTheSameIdentity() {
        repository.synchronizeSource(
            "BIZINFO",
            listOf(catalogProgram(id = "PBLN_CASE", title = "변경 전 공고")),
        )
        val updated = catalogProgram(id = "pbln_case", title = "변경 후 공고")

        repository.synchronizeSource("BIZINFO", listOf(updated))

        assertEquals(1, countRows("BIZINFO"))
        assertEquals(
            updated,
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_CASE"),
        )
        val stored = requireNotNull(
            repository.findPresentBySourceAndProgramId("BIZINFO", "pbln_case"),
        )
        assertEquals("pbln_case", stored.program.id)
        assertEquals(
            "BIZINFO:pbln_case",
            SupportProgramIndexDocumentMapper.fromCatalog(stored).id,
        )
    }

    @Test
    fun returnsNullWhenProgramDoesNotExist() {
        assertNull(repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_NOT_FOUND"))
    }

    @Test
    fun storesSourceDocumentsByCompositeIdentityAndHidesThemWhenTheProgramIsInactive() {
        val program = catalogProgram(id = "PBLN_EVIDENCE", title = "근거 공고")
        repository.upsert(program)
        val content = "공식 원문입니다. 온라인으로 신청하고 문의는 수행기관에 합니다."
        val document = SupportProgramSourceDocument(
            sourceCode = "BIZINFO",
            sourceProgramId = "PBLN_EVIDENCE",
            sourceUrl = program.program.sourceUrl,
            content = content,
            contentHash = SupportProgramContentHashHelper.sha256(content),
            fetchedAt = LocalDateTime.of(2026, 9, 5, 12, 0),
        )

        repository.upsertSourceDocument(document)

        assertEquals(
            document,
            repository.findPresentSourceDocument("BIZINFO", "PBLN_EVIDENCE"),
        )

        repository.synchronizeSource("BIZINFO", emptyList())

        assertNull(repository.findPresentSourceDocument("BIZINFO", "PBLN_EVIDENCE"))
    }

    @Test
    fun replacesEverySourceDocumentValueWhenUpsertingTheSameCompositeIdentity() {
        val program = catalogProgram(id = "PBLN_EVIDENCE_UPSERT", title = "근거 갱신 공고")
        repository.upsert(program)
        val originalContent = "최초 공식 원문입니다. 온라인으로 신청합니다."
        val updatedContent = "갱신된 공식 원문입니다. 신청 방법과 제출 서류를 확인합니다."
        val original = SupportProgramSourceDocument(
            sourceCode = "BIZINFO",
            sourceProgramId = program.program.id,
            sourceUrl = program.program.sourceUrl,
            content = originalContent,
            contentHash = SupportProgramContentHashHelper.sha256(originalContent),
            fetchedAt = LocalDateTime.of(2026, 9, 5, 10, 0),
        )
        val updated = original.copy(
            content = updatedContent,
            contentHash = SupportProgramContentHashHelper.sha256(updatedContent),
            fetchedAt = LocalDateTime.of(2026, 9, 5, 12, 0),
        )

        repository.upsertSourceDocument(original)
        repository.upsertSourceDocument(updated)

        assertEquals(
            updated,
            repository.findPresentSourceDocument("BIZINFO", "PBLN_EVIDENCE_UPSERT"),
        )
        assertEquals(1, countSourceDocumentRows("BIZINFO", "PBLN_EVIDENCE_UPSERT"))
    }

    @Test
    fun separatesSourceDocumentsWhoseRawProgramIdsMatchAcrossSources() {
        val rawProgramId = "SHARED_EVIDENCE_ID"
        val bizInfoProgram = catalogProgram(id = rawProgramId, title = "기업마당 근거 공고")
        repository.upsert(bizInfoProgram)
        insertProgram(sourceCode = "OTHER", sourceProgramId = rawProgramId, title = "다른 제공처 근거 공고")
        val bizInfoContent = "기업마당 공식 원문입니다. 온라인 신청을 안내합니다."
        val otherContent = "다른 제공처 공식 원문입니다. 별도 신청 절차를 안내합니다."
        val bizInfoDocument = SupportProgramSourceDocument(
            sourceCode = "BIZINFO",
            sourceProgramId = rawProgramId,
            sourceUrl = bizInfoProgram.program.sourceUrl,
            content = bizInfoContent,
            contentHash = SupportProgramContentHashHelper.sha256(bizInfoContent),
            fetchedAt = LocalDateTime.of(2026, 9, 5, 12, 0),
        )
        val otherDocument = SupportProgramSourceDocument(
            sourceCode = "OTHER",
            sourceProgramId = rawProgramId,
            sourceUrl = "https://example.com/program/$rawProgramId",
            content = otherContent,
            contentHash = SupportProgramContentHashHelper.sha256(otherContent),
            fetchedAt = LocalDateTime.of(2026, 9, 5, 12, 0),
        )

        repository.upsertSourceDocument(bizInfoDocument)
        repository.upsertSourceDocument(otherDocument)

        assertEquals(bizInfoDocument, repository.findPresentSourceDocument("BIZINFO", rawProgramId))
        assertEquals(otherDocument, repository.findPresentSourceDocument("OTHER", rawProgramId))
        assertEquals(1, countSourceDocumentRows("BIZINFO", rawProgramId))
        assertEquals(1, countSourceDocumentRows("OTHER", rawProgramId))
    }

    @Test
    fun findsProgramsByTheCompleteSourceIdentityAndExcludesInactiveRows() {
        val bizInfoProgram = catalogProgram(id = "SHARED_ID", title = "기업마당 공고")
        repository.upsert(bizInfoProgram)
        insertProgram(sourceCode = "OTHER", sourceProgramId = "SHARED_ID", title = "다른 제공처 공고")

        assertEquals(
            bizInfoProgram,
            repository.findPresentBySourceAndProgramId("BIZINFO", "SHARED_ID"),
        )
        val otherProgram = requireNotNull(
            repository.findPresentBySourceAndProgramId("OTHER", "SHARED_ID"),
        )
        assertEquals("OTHER", otherProgram.program.sourceCode)
        assertEquals("OTHER", otherProgram.program.sourceName)
        assertEquals("다른 제공처 공고", otherProgram.program.title)

        repository.synchronizeSource("BIZINFO", emptyList())

        assertNull(repository.findPresentBySourceAndProgramId("BIZINFO", "SHARED_ID"))
        assertEquals(
            "다른 제공처 공고",
            repository.findPresentBySourceAndProgramId("OTHER", "SHARED_ID")?.program?.title,
        )
    }

    @Test
    fun findsPresentProgramsAcrossSourcesForRepairAndEvaluation() {
        val current = catalogProgram(id = "PBLN_CURRENT", title = "현재 노출 공고")
        val missing = catalogProgram(id = "PBLN_MISSING", title = "사라진 공고")
        repository.synchronizeSource("BIZINFO", listOf(current, missing))
        repository.synchronizeSource("BIZINFO", listOf(current))
        insertProgram(sourceCode = "OTHER", sourceProgramId = "PBLN_OTHER", title = "다른 제공처 공고")

        assertEquals(
            listOf("BIZINFO:PBLN_CURRENT", "OTHER:PBLN_OTHER"),
            repository.findPresent().map { it.program.sourceQualifiedId },
        )
    }

    @Test
    fun excludesClosedAndUpcomingDatabaseProgramsWhenAcceptingOnly() {
        val open = catalogProgram(id = "PBLN_OPEN", title = "접수 중 공고")
        val closed = catalogProgram(
            id = "PBLN_CLOSED",
            title = "마감 공고",
            applicationPeriod = "2000-01-01 ~ 2000-01-31",
            applicationStartDate = LocalDate.of(2000, 1, 1),
            applicationEndDate = LocalDate.of(2000, 1, 31),
        )
        val upcoming = catalogProgram(
            id = "PBLN_UPCOMING",
            title = "예정 공고",
            applicationPeriod = "9999-01-01 ~ 9999-12-31",
            applicationStartDate = LocalDate.of(9999, 1, 1),
            applicationEndDate = LocalDate.of(9999, 12, 31),
        )
        val generation = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", listOf(open, closed, upcoming), generation))

        val result = supportProgramSearchService.search("", acceptingOnly = true)

        assertEquals(listOf("PBLN_OPEN"), result.programs.map(SupportProgram::id))
    }

    @Test
    fun synchronizesTheSameSnapshotTwiceWithoutCreatingDuplicates() {
        val snapshot = listOf(
            catalogProgram(id = "PBLN_SYNC_A", title = "동일 공고 A"),
            catalogProgram(id = "PBLN_SYNC_B", title = "동일 공고 B"),
        )

        repository.synchronizeSource("BIZINFO", snapshot)
        repository.synchronizeSource("BIZINFO", snapshot)

        assertEquals(2, countRows("BIZINFO"))
        assertEquals(2, countPresentRows("BIZINFO"))
        assertEquals(
            snapshot[0],
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_SYNC_A"),
        )
        assertEquals(
            snapshot[1],
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_SYNC_B"),
        )
    }

    @Test
    fun publishesOnlyTheMostRecentlyStartedBizInfoSyncGeneration() {
        val original = catalogProgram(id = "PBLN_ORIGINAL", title = "기존 공개 공고")
        val staleSnapshot = listOf(catalogProgram(id = "PBLN_STALE", title = "늦게 끝난 이전 수집"))
        val currentSnapshot = listOf(catalogProgram(id = "PBLN_CURRENT", title = "최신 수집 공고"))
        repository.synchronizeSource("BIZINFO", listOf(original))

        val staleGeneration = repository.startSyncGeneration("BIZINFO")
        val currentGeneration = repository.startSyncGeneration("BIZINFO")

        assertFalse(repository.publishSnapshotIfCurrent("BIZINFO", staleSnapshot, staleGeneration))
        assertEquals(
            original,
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_ORIGINAL"),
        )

        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", currentSnapshot, currentGeneration))
        assertNull(repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_ORIGINAL"))
        assertEquals(
            currentSnapshot.single(),
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_CURRENT"),
        )
    }

    @Test
    fun publishesTheSnapshotAndTrustedReadinessMetadataAtomically() {
        val snapshot = listOf(
            catalogProgram(id = "PBLN_READY_A", title = "준비 완료 공고 A"),
            catalogProgram(id = "PBLN_READY_B", title = "준비 완료 공고 B"),
        )
        val generation = repository.startSyncGeneration("BIZINFO")

        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", snapshot, generation))

        val status = requireNotNull(repository.findSyncStatus("BIZINFO"))
        assertEquals(generation, status.publishedGeneration)
        assertEquals(SupportProgramCatalogFingerprintHelper.calculate(snapshot), status.publishedCatalogFingerprint)
        assertEquals(2, status.publishedProgramCount)
        assertTrue(status.indexReady)
        assertEquals(SupportProgramSyncOutcome.SUCCESS, status.lastSyncOutcome)
        assertTrue(status.lastSuccessfulSyncAt != null)
        assertNull(status.lastFailedSyncAt)
        assertEquals(2, countPresentRows("BIZINFO"))
    }

    @Test
    fun keepsThePreviousReadySnapshotWhenTheNextCurrentGenerationFails() {
        val published = listOf(catalogProgram(id = "PBLN_PUBLISHED", title = "기존 검색 가능 공고"))
        val publishedGeneration = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", published, publishedGeneration))
        val beforeFailure = requireNotNull(repository.findSyncStatus("BIZINFO"))

        val failedGeneration = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.recordSyncFailureIfCurrent("BIZINFO", failedGeneration))

        val afterFailure = requireNotNull(repository.findSyncStatus("BIZINFO"))
        assertEquals(publishedGeneration, afterFailure.publishedGeneration)
        assertEquals(beforeFailure.publishedCatalogFingerprint, afterFailure.publishedCatalogFingerprint)
        assertEquals(1, afterFailure.publishedProgramCount)
        assertTrue(afterFailure.indexReady)
        assertEquals(beforeFailure.lastSuccessfulSyncAt, afterFailure.lastSuccessfulSyncAt)
        assertTrue(afterFailure.lastFailedSyncAt != null)
        assertEquals(SupportProgramSyncOutcome.FAILURE, afterFailure.lastSyncOutcome)
        assertEquals(published.single(), repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_PUBLISHED"))
    }

    @Test
    fun recordsAnInitialSyncFailureWithoutInventingAPublishedSnapshot() {
        val generation = repository.startSyncGeneration("BIZINFO")

        assertTrue(repository.recordSyncFailureIfCurrent("BIZINFO", generation))

        val status = requireNotNull(repository.findSyncStatus("BIZINFO"))
        assertNull(status.publishedGeneration)
        assertNull(status.publishedCatalogFingerprint)
        assertEquals(0, status.publishedProgramCount)
        assertFalse(status.indexReady)
        assertNull(status.lastSuccessfulSyncAt)
        assertTrue(status.lastFailedSyncAt != null)
        assertEquals(SupportProgramSyncOutcome.FAILURE, status.lastSyncOutcome)
    }

    @Test
    fun adoptsACompletedLegacyRepairWithoutErasingTheRecordedCatalogSyncFailure() {
        val legacySnapshot = listOf(catalogProgram(id = "PBLN_LEGACY", title = "기존 공개 공고"))
        repository.synchronizeSource("BIZINFO", legacySnapshot)
        val failedGeneration = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.recordSyncFailureIfCurrent("BIZINFO", failedGeneration))
        val beforeBootstrap = requireNotNull(repository.findSyncStatus("BIZINFO"))

        assertTrue(
            repository.bootstrapLegacySnapshotAfterSuccessfulRepair(
                "BIZINFO",
                repository.findPresent(),
            ),
        )

        val adopted = requireNotNull(repository.findSyncStatus("BIZINFO"))
        assertEquals(0L, adopted.publishedGeneration)
        assertEquals(SupportProgramCatalogFingerprintHelper.calculate(legacySnapshot), adopted.publishedCatalogFingerprint)
        assertEquals(1, adopted.publishedProgramCount)
        assertTrue(adopted.indexReady)
        assertEquals(SupportProgramSyncOutcome.FAILURE, adopted.lastSyncOutcome)
        assertEquals(beforeBootstrap.lastSuccessfulSyncAt, adopted.lastSuccessfulSyncAt)
        assertEquals(beforeBootstrap.lastFailedSyncAt, adopted.lastFailedSyncAt)
    }

    @Test
    fun doesNotBootstrapAnEmptyCatalogOrOverwriteTrustedPublishedMetadata() {
        assertFalse(repository.bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", emptyList()))
        assertNull(repository.findSyncStatus("BIZINFO"))

        val publishedSnapshot = listOf(catalogProgram(id = "PBLN_TRUSTED", title = "신뢰된 공고"))
        val generation = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", publishedSnapshot, generation))
        val trusted = requireNotNull(repository.findSyncStatus("BIZINFO"))
        val unrelatedSnapshot = listOf(catalogProgram(id = "PBLN_OTHER", title = "다른 legacy 공고"))

        assertFalse(repository.bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", unrelatedSnapshot))
        assertEquals(trusted, repository.findSyncStatus("BIZINFO"))
    }

    @Test
    fun doesNotRecordASupersededGenerationFailureOverTheCurrentPublishedStatus() {
        val snapshot = listOf(catalogProgram(id = "PBLN_CURRENT_STATUS", title = "현재 상태 공고"))
        val publishedGeneration = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", snapshot, publishedGeneration))
        val beforeSupersededFailure = requireNotNull(repository.findSyncStatus("BIZINFO"))

        val staleGeneration = repository.startSyncGeneration("BIZINFO")
        repository.startSyncGeneration("BIZINFO")

        assertFalse(repository.recordSyncFailureIfCurrent("BIZINFO", staleGeneration))

        assertEquals(beforeSupersededFailure, repository.findSyncStatus("BIZINFO"))
    }

    @Test
    fun conditionallyChangesOnlyTheIndexedSnapshotReadinessWithoutChangingCatalogSyncOutcome() {
        val snapshot = listOf(catalogProgram(id = "PBLN_REPAIR", title = "색인 복구 대상"))
        val generation = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", snapshot, generation))
        val published = requireNotNull(repository.findSyncStatus("BIZINFO"))
        val fingerprint = requireNotNull(published.publishedCatalogFingerprint)

        assertFalse(
            repository.markIndexNotReadyIfPublishedSnapshotMatches(
                "BIZINFO",
                publishedGeneration = generation + 1,
                expectedCatalogFingerprint = fingerprint,
                expectedProgramCount = 1,
            ),
        )
        assertTrue(requireNotNull(repository.findSyncStatus("BIZINFO")).indexReady)

        assertTrue(
            repository.markIndexNotReadyIfPublishedSnapshotMatches(
                "BIZINFO",
                publishedGeneration = generation,
                expectedCatalogFingerprint = fingerprint,
                expectedProgramCount = 1,
            ),
        )
        val notReady = requireNotNull(repository.findSyncStatus("BIZINFO"))
        assertFalse(notReady.indexReady)
        assertEquals(SupportProgramSyncOutcome.SUCCESS, notReady.lastSyncOutcome)
        assertEquals(published.lastSuccessfulSyncAt, notReady.lastSuccessfulSyncAt)
        assertNull(notReady.lastFailedSyncAt)

        assertTrue(
            repository.markIndexReadyIfPublishedSnapshotMatches(
                "BIZINFO",
                publishedGeneration = generation,
                expectedCatalogFingerprint = fingerprint,
                expectedProgramCount = 1,
            ),
        )
        assertTrue(requireNotNull(repository.findSyncStatus("BIZINFO")).indexReady)
    }

    @Test
    fun publishesAnEmptySuccessfulSnapshotAsTrustedAndIndexReady() {
        val generation = repository.startSyncGeneration("BIZINFO")

        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", emptyList(), generation))

        val status = requireNotNull(repository.findSyncStatus("BIZINFO"))
        assertEquals(generation, status.publishedGeneration)
        assertEquals(SupportProgramCatalogFingerprintHelper.calculate(emptyList()), status.publishedCatalogFingerprint)
        assertEquals(0, status.publishedProgramCount)
        assertTrue(status.indexReady)
        assertEquals(SupportProgramSyncOutcome.SUCCESS, status.lastSyncOutcome)
    }

    @Test
    fun marksOnlyMissingBizInfoProgramsAsNotPresent() {
        val remaining = catalogProgram(id = "PBLN_REMAINING", title = "계속 제공되는 공고")
        val missing = catalogProgram(id = "PBLN_MISSING", title = "사라진 공고")
        repository.synchronizeSource("BIZINFO", listOf(remaining, missing))

        repository.synchronizeSource("BIZINFO", listOf(remaining))

        assertEquals(2, countRows("BIZINFO"))
        assertTrue(isSourcePresent("BIZINFO", "PBLN_REMAINING"))
        assertFalse(isSourcePresent("BIZINFO", "PBLN_MISSING"))
        assertNull(repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_MISSING"))
    }

    @Test
    fun marksAReappearingBizInfoProgramAsPresentAgain() {
        val remaining = catalogProgram(id = "PBLN_ALWAYS", title = "계속 제공되는 공고")
        val reappearing = catalogProgram(id = "PBLN_REAPPEARING", title = "재등장 공고")
        repository.synchronizeSource("BIZINFO", listOf(remaining, reappearing))
        repository.synchronizeSource("BIZINFO", listOf(remaining))

        repository.synchronizeSource("BIZINFO", listOf(remaining, reappearing))

        assertTrue(isSourcePresent("BIZINFO", "PBLN_REAPPEARING"))
        assertEquals(
            reappearing,
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_REAPPEARING"),
        )
    }

    @Test
    fun doesNotChangeProgramsFromAnotherSource() {
        insertProgram(sourceCode = "OTHER", sourceProgramId = "SHARED_ID", title = "다른 제공처 공고")
        repository.synchronizeSource(
            "BIZINFO",
            listOf(catalogProgram(id = "SHARED_ID", title = "기업마당 공고")),
        )

        repository.synchronizeSource("BIZINFO", emptyList())

        assertTrue(isSourcePresent("OTHER", "SHARED_ID"))
        assertFalse(isSourcePresent("BIZINFO", "SHARED_ID"))
        assertEquals(1, countRows("OTHER"))
    }

    @Test
    fun rejectsAnotherSourceBeforeItCanReplaceTheBizInfoSnapshot() {
        val existing = catalogProgram(id = "PBLN_EXISTING", title = "기존 기업마당 공고")
        val otherSourceProgram = existing.copy(
            program = existing.program.copy(
                id = "OTHER_1",
                sourceCode = "OTHER",
                title = "잘못 섞인 다른 제공처 공고",
            ),
        )
        repository.synchronizeSource("BIZINFO", listOf(existing))

        assertThrows(IllegalArgumentException::class.java) {
            repository.synchronizeSource("BIZINFO", listOf(otherSourceProgram))
        }

        assertEquals(
            existing,
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_EXISTING"),
        )
        assertEquals(0, countRows("OTHER"))
    }

    @Test
    fun rollsBackTheWholeSnapshotWhenAnUpsertFails() {
        val original = catalogProgram(id = "PBLN_ROLLBACK_A", title = "변경 전 공고")
        val shouldRemainPresent = catalogProgram(id = "PBLN_ROLLBACK_B", title = "유지되어야 하는 공고")
        repository.synchronizeSource("BIZINFO", listOf(original, shouldRemainPresent))
        val changed = original.copy(program = original.program.copy(title = "롤백되어야 하는 변경"))
        val invalid = catalogProgram(
            id = "PBLN_TOO_LONG",
            title = "가".repeat(501),
        )
        val earlierBatchInserts = (0 until 100).map { index ->
            catalogProgram(id = "PBLN_ROLLBACK_NEW_$index", title = "롤백되어야 하는 신규 공고")
        }

        assertThrows(DataAccessException::class.java) {
            repository.synchronizeSource("BIZINFO", listOf(changed) + earlierBatchInserts + invalid)
        }

        assertEquals(
            original,
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_ROLLBACK_A"),
        )
        assertEquals(
            shouldRemainPresent,
            repository.findPresentBySourceAndProgramId("BIZINFO", "PBLN_ROLLBACK_B"),
        )
        assertEquals(2, countPresentRows("BIZINFO"))
        assertEquals(2, countRows("BIZINFO"))
        assertEquals(0, countRowsByProgramId("BIZINFO", "PBLN_TOO_LONG"))
    }

    @Test
    fun synchronizesAndDeactivatesTheSameRawIdIndependentlyForEachSource() {
        val bizInfo = catalogProgram(id = "SHARED_ID", title = "기업마당 공고")
        val kStartup = catalogProgram(id = "SHARED_ID", title = "창업 공고", sourceCode = "KSTARTUP")

        repository.synchronizeSource("BIZINFO", listOf(bizInfo))
        repository.synchronizeSource("KSTARTUP", listOf(kStartup))
        repository.synchronizeSource("KSTARTUP", listOf(kStartup))

        assertEquals(bizInfo, repository.findPresentBySourceAndProgramId("BIZINFO", "SHARED_ID"))
        assertEquals(kStartup, repository.findPresentBySourceAndProgramId("KSTARTUP", "SHARED_ID"))
        assertEquals(1, countRows("KSTARTUP"))

        repository.synchronizeSource("KSTARTUP", emptyList())

        assertEquals(bizInfo, repository.findPresentBySourceAndProgramId("BIZINFO", "SHARED_ID"))
        assertNull(repository.findPresentBySourceAndProgramId("KSTARTUP", "SHARED_ID"))
    }

    @Test
    fun startsEachSourceAsPendingAndKeepsItsPublicationGenerationAndFailureIndependent() {
        assertTrue(repository.findSyncStatuses().isEmpty())
        val staleBizInfoGeneration = repository.startSyncGeneration("BIZINFO")
        val kStartupGeneration = repository.startSyncGeneration("KSTARTUP")
        val bizInfoGeneration = repository.startSyncGeneration("BIZINFO")
        val pendingStatuses = repository.findSyncStatuses()
        assertEquals(listOf("BIZINFO", "KSTARTUP"), pendingStatuses.map { it.sourceCode })
        pendingStatuses.forEach { status ->
            assertFalse(status.indexReady)
            assertNull(status.publishedGeneration)
            assertNull(status.publishedCatalogFingerprint)
            assertEquals(SupportProgramSyncOutcome.NONE, status.lastSyncOutcome)
        }
        assertEquals(1L, kStartupGeneration)
        assertEquals(2L, bizInfoGeneration)
        val bizInfo = listOf(catalogProgram(id = "SHARED_ID", title = "최신 기업마당 공고"))
        val kStartup = listOf(catalogProgram(id = "SHARED_ID", title = "최신 창업 공고", sourceCode = "KSTARTUP"))

        assertTrue(repository.publishSnapshotIfCurrent("KSTARTUP", kStartup, kStartupGeneration))
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", bizInfo, bizInfoGeneration))
        val publishedBizInfo = requireNotNull(repository.findSyncStatus("BIZINFO"))
        val publishedKStartup = requireNotNull(repository.findSyncStatus("KSTARTUP"))
        assertFalse(repository.publishSnapshotIfCurrent("BIZINFO", emptyList(), staleBizInfoGeneration))
        assertFalse(repository.recordSyncFailureIfCurrent("BIZINFO", staleBizInfoGeneration))
        assertEquals(publishedBizInfo, repository.findSyncStatus("BIZINFO"))
        assertEquals(publishedKStartup, repository.findSyncStatus("KSTARTUP"))

        val failedKStartupGeneration = repository.startSyncGeneration("KSTARTUP")
        assertTrue(repository.recordSyncFailureIfCurrent("KSTARTUP", failedKStartupGeneration))

        val failedKStartup = requireNotNull(repository.findSyncStatus("KSTARTUP"))
        assertEquals(publishedBizInfo, repository.findSyncStatus("BIZINFO"))
        assertEquals(SupportProgramSyncOutcome.FAILURE, failedKStartup.lastSyncOutcome)
        assertEquals(publishedKStartup.publishedCatalogFingerprint, failedKStartup.publishedCatalogFingerprint)
        assertEquals(kStartupGeneration, failedKStartup.publishedGeneration)
        assertTrue(failedKStartup.indexReady)
        assertEquals(kStartup.single(), repository.findPresentBySourceAndProgramId("KSTARTUP", "SHARED_ID"))
        assertEquals(bizInfo.single(), repository.findPresentBySourceAndProgramId("BIZINFO", "SHARED_ID"))
    }

    @Test
    fun readsOnlyPresentProgramsFromIndexReadySourcesAndPreservesTheCompleteRepairCatalog() {
        val bizInfo = catalogProgram(id = "SHARED_ID", title = "검색 가능한 기업마당 공고")
        val removed = catalogProgram(id = "REMOVED", title = "사라진 기업마당 공고")
        val kStartup = catalogProgram(id = "SHARED_ID", title = "창업 공고", sourceCode = "KSTARTUP")
        val pending = catalogProgram(id = "PENDING", title = "최초 동기화 중 공고", sourceCode = "OTHER")
        val legacy = catalogProgram(id = "LEGACY", title = "복구 전 기존 공고", sourceCode = "LEGACY")
        repository.synchronizeSource("BIZINFO", listOf(bizInfo, removed))
        val bizInfoGeneration = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", listOf(bizInfo), bizInfoGeneration))
        val kStartupGeneration = repository.startSyncGeneration("KSTARTUP")
        assertTrue(repository.publishSnapshotIfCurrent("KSTARTUP", listOf(kStartup), kStartupGeneration))
        repository.synchronizeSource("OTHER", listOf(pending))
        repository.startSyncGeneration("OTHER")
        repository.synchronizeSource("LEGACY", listOf(legacy))
        val kStartupFingerprint = SupportProgramCatalogFingerprintHelper.calculate(listOf(kStartup))
        assertTrue(
            repository.markIndexNotReadyIfPublishedSnapshotMatches(
                "KSTARTUP", kStartupGeneration, kStartupFingerprint, 1,
            ),
        )

        assertEquals(listOf(bizInfo), repository.findSearchablePresent())
        assertEquals(
            listOf("BIZINFO:SHARED_ID", "KSTARTUP:SHARED_ID", "LEGACY:LEGACY", "OTHER:PENDING"),
            repository.findPresent().map { it.program.sourceQualifiedId },
        )
        assertTrue(requireNotNull(repository.findSyncStatus("BIZINFO")).indexReady)
        assertTrue(
            repository.markIndexReadyIfPublishedSnapshotMatches(
                "KSTARTUP", kStartupGeneration, kStartupFingerprint, 1,
            ),
        )
        assertEquals(listOf(bizInfo, kStartup), repository.findSearchablePresent())

        val failureGeneration = repository.startSyncGeneration("KSTARTUP")
        assertTrue(repository.recordSyncFailureIfCurrent("KSTARTUP", failureGeneration))
        assertEquals(listOf(bizInfo, kStartup), repository.findSearchablePresent())
    }

    @Test
    fun keepsPublishedLatestProgramsAndDetailsAvailableDuringIndexOutageWithoutExposingPendingSources() {
        val published = catalogProgram(id = "PUBLISHED", title = "기존 공개 공고")
        val removed = catalogProgram(id = "REMOVED", title = "이미 제거된 공고")
        repository.synchronizeSource("BIZINFO", listOf(published, removed))
        val generation = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", listOf(published), generation))
        repository.synchronizeSource("KSTARTUP", listOf(catalogProgram("PENDING", "미공개", "KSTARTUP")))
        repository.startSyncGeneration("KSTARTUP")
        repository.synchronizeSource("LEGACY", listOf(catalogProgram("LEGACY", "미검증", "LEGACY")))
        assertTrue(repository.markIndexNotReadyIfPublishedSnapshotMatches(
            "BIZINFO", generation, SupportProgramCatalogFingerprintHelper.calculate(listOf(published)), 1,
        ))

        val result = supportProgramSearchService.search("  ", acceptingOnly = true)

        assertEquals(listOf("BIZINFO:PUBLISHED"), result.programs.map { it.sourceQualifiedId })
        assertNull(result.programs.single().recommendationScore)
        assertEquals(published, repository.findPresentBySourceAndProgramId("BIZINFO", "PUBLISHED"))
        assertTrue(repository.findSearchablePresent().isEmpty())
    }

    @Test
    fun doesNotDisguiseAnUnavailablePublishedSearchIndexAsNoNaturalLanguageMatches() {
        val published = catalogProgram(id = "PUBLISHED", title = "기존 공개 공고")
        val generation = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", listOf(published), generation))
        assertTrue(repository.markIndexNotReadyIfPublishedSnapshotMatches(
            "BIZINFO", generation, SupportProgramCatalogFingerprintHelper.calculate(listOf(published)), 1,
        ))

        val exception = assertThrows(AiServiceCallException::class.java) {
            supportProgramSearchService.search("서울 AI", acceptingOnly = true)
        }
        assertEquals(AiServiceFailure.UNAVAILABLE, exception.failure)
    }

    @Test
    fun allowsAnActuallyEmptyReadySourceWhileAnotherPublishedSourceHasAnIndexOutage() {
        val published = catalogProgram(id = "PUBLISHED", title = "기존 공개 공고")
        val generation = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", listOf(published), generation))
        assertTrue(repository.markIndexNotReadyIfPublishedSnapshotMatches(
            "BIZINFO", generation, SupportProgramCatalogFingerprintHelper.calculate(listOf(published)), 1,
        ))
        val emptyGeneration = repository.startSyncGeneration("KSTARTUP")
        assertTrue(repository.publishSnapshotIfCurrent("KSTARTUP", emptyList(), emptyGeneration))

        assertTrue(supportProgramSearchService.search("서울 AI", acceptingOnly = true).programs.isEmpty())
    }

    @Test
    fun distinguishesAnUnrepairedLegacyCatalogFromAnInitiallyEmptyDatabase() {
        assertTrue(supportProgramSearchService.search("서울 AI", acceptingOnly = true).programs.isEmpty())
        repository.synchronizeSource("BIZINFO", listOf(catalogProgram("LEGACY", "아직 복구하지 않은 공고")))

        val exception = assertThrows(AiServiceCallException::class.java) {
            supportProgramSearchService.search("서울 AI", acceptingOnly = true)
        }
        assertEquals(AiServiceFailure.UNAVAILABLE, exception.failure)
        assertTrue(supportProgramSearchService.search("", acceptingOnly = true).programs.isEmpty())
    }

    @Test
    fun rejectsMixedSourcePublicationAndLegacyBootstrapBeforeChangingEitherSource() {
        val bizInfo = catalogProgram(id = "SHARED_ID", title = "기존 기업마당 공고")
        val kStartup = catalogProgram(id = "SHARED_ID", title = "기존 창업 공고", sourceCode = "KSTARTUP")
        repository.synchronizeSource("BIZINFO", listOf(bizInfo))
        repository.synchronizeSource("KSTARTUP", listOf(kStartup))

        assertThrows(IllegalArgumentException::class.java) {
            repository.bootstrapLegacySnapshotAfterSuccessfulRepair("KSTARTUP", listOf(kStartup, bizInfo))
        }
        assertNull(repository.findSyncStatus("BIZINFO"))
        assertNull(repository.findSyncStatus("KSTARTUP"))
        assertTrue(repository.bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", listOf(bizInfo)))
        assertTrue(repository.bootstrapLegacySnapshotAfterSuccessfulRepair("KSTARTUP", listOf(kStartup)))
        val generation = repository.startSyncGeneration("KSTARTUP")
        val previousStatuses = repository.findSyncStatuses()
        val changed = kStartup.copy(program = kStartup.program.copy(title = "저장되지 않을 변경"))

        assertThrows(IllegalArgumentException::class.java) {
            repository.publishSnapshotIfCurrent("KSTARTUP", listOf(changed, bizInfo), generation)
        }
        assertThrows(IllegalArgumentException::class.java) {
            repository.synchronizeSource("KSTARTUP", listOf(changed, bizInfo))
        }

        assertEquals(previousStatuses, repository.findSyncStatuses())
        assertEquals(listOf(bizInfo, kStartup), repository.findPresent())
    }

    @Test
    fun reportsLegacySourcesWithoutStatusRowsAndReplacesTheirUnverifiedStateAfterSuccessfulRepair() {
        val bizInfo = catalogProgram(id = "READY", title = "준비된 기업마당 공고")
        val otherPrograms = listOf(
            catalogProgram(id = "LEGACY_A", title = "기존 공고 A", sourceCode = "OTHER"),
            catalogProgram(id = "LEGACY_B", title = "기존 공고 B", sourceCode = "OTHER"),
        )
        val removed = catalogProgram(id = "REMOVED", title = "사라진 기존 공고", sourceCode = "OTHER")
        val inactive = catalogProgram(id = "INACTIVE", title = "전부 사라진 제공처 공고", sourceCode = "INACTIVE")
        val bizInfoGeneration = repository.startSyncGeneration("BIZINFO")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", listOf(bizInfo), bizInfoGeneration))
        repository.synchronizeSource("OTHER", otherPrograms + removed)
        repository.synchronizeSource("OTHER", otherPrograms)
        repository.synchronizeSource("INACTIVE", listOf(inactive))
        repository.synchronizeSource("INACTIVE", emptyList())

        val statuses = repository.findSyncStatuses()

        assertEquals(listOf("BIZINFO", "OTHER"), statuses.map { it.sourceCode })
        assertTrue(statuses.first().indexReady)
        val unverified = statuses.last()
        assertEquals(2, unverified.publishedProgramCount)
        assertFalse(unverified.indexReady)
        assertNull(unverified.publishedGeneration)
        assertNull(unverified.publishedCatalogFingerprint)
        assertNull(unverified.lastSuccessfulSyncAt)
        assertNull(unverified.lastFailedSyncAt)
        assertEquals(SupportProgramSyncOutcome.NONE, unverified.lastSyncOutcome)
        assertNull(repository.findSyncStatus("OTHER"))
        assertEquals(listOf(bizInfo), repository.findSearchablePresent())

        assertTrue(repository.bootstrapLegacySnapshotAfterSuccessfulRepair("OTHER", otherPrograms))

        val repairedStatuses = repository.findSyncStatuses()
        assertEquals(listOf("BIZINFO", "OTHER"), repairedStatuses.map { it.sourceCode })
        assertEquals(statuses.first(), repairedStatuses.first())
        val repaired = repairedStatuses.last()
        assertEquals(repository.findSyncStatus("OTHER"), repaired)
        assertEquals(2, repaired.publishedProgramCount)
        assertEquals(0L, repaired.publishedGeneration)
        assertTrue(repaired.indexReady)
        assertEquals(SupportProgramCatalogFingerprintHelper.calculate(otherPrograms), repaired.publishedCatalogFingerprint)
        assertEquals(listOf(bizInfo) + otherPrograms, repository.findSearchablePresent())
    }

    @Test
    fun rollsBackFailedPublicationWithoutChangingEitherSourcesSnapshotOrStatus() {
        val bizInfo = catalogProgram(id = "SHARED_ID", title = "기존 기업마당 공고")
        val kStartup = catalogProgram(id = "SHARED_ID", title = "기존 창업 공고", sourceCode = "KSTARTUP")
        val bizInfoGeneration = repository.startSyncGeneration("BIZINFO")
        val kStartupGeneration = repository.startSyncGeneration("KSTARTUP")
        assertTrue(repository.publishSnapshotIfCurrent("BIZINFO", listOf(bizInfo), bizInfoGeneration))
        assertTrue(repository.publishSnapshotIfCurrent("KSTARTUP", listOf(kStartup), kStartupGeneration))
        val previousStatuses = repository.findSyncStatuses()
        val nextGeneration = repository.startSyncGeneration("KSTARTUP")
        val changed = kStartup.copy(program = kStartup.program.copy(title = "롤백할 창업 공고 변경"))
        val invalid = catalogProgram(id = "TOO_LONG", title = "가".repeat(501), sourceCode = "KSTARTUP")

        assertThrows(DataAccessException::class.java) {
            repository.publishSnapshotIfCurrent("KSTARTUP", listOf(changed, invalid), nextGeneration)
        }

        assertEquals(previousStatuses, repository.findSyncStatuses())
        assertEquals(listOf(bizInfo, kStartup), repository.findSearchablePresent())
        assertEquals(0, countRowsByProgramId("KSTARTUP", "TOO_LONG"))
    }

    @Test
    fun rejectsInvalidSourceCodesBeforeWritingAndAcceptsTheMaximumCanonicalLength() {
        val invalidCodes = listOf("", "bizinfo", "BIZINFO ", " BIZINFO", "K-STARTUP", "1SOURCE", "A".repeat(65))
        invalidCodes.forEach { sourceCode ->
            assertThrows(IllegalArgumentException::class.java) {
                repository.startSyncGeneration(sourceCode)
            }
            assertThrows(IllegalArgumentException::class.java) {
                repository.synchronizeSource(sourceCode, emptyList())
            }
            assertThrows(IllegalArgumentException::class.java) {
                repository.upsert(catalogProgram(id = "INVALID_SOURCE", title = "잘못된 제공처", sourceCode = sourceCode))
            }
        }

        assertTrue(repository.findSyncStatuses().isEmpty())
        assertTrue(repository.findPresent().isEmpty())
        val validCode = "A" + "_0".repeat(31) + "Z"
        assertEquals(1L, repository.startSyncGeneration(validCode))
        assertEquals(validCode, repository.findSyncStatuses().single().sourceCode)
    }

    @ParameterizedTest
    @ValueSource(strings = ["MSIT", "CNTRADE_NOTICE"])
    fun noticeSyncIsIdempotentAndDeactivatesOnlyItsMissingNotices(source: String) {
        val otherSources = listOf("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE").filter { it != source }
        val others = otherSources.map { catalogProgram("shared", "다른 제공처의 같은 ID", sourceCode = it) }
        others.forEach { repository.upsert(it) }
        val notice = catalogProgram("shared", "연구·수출 \"지원\" & 안내", sourceCode = source,
            categories = emptyList(), regions = emptyList(), applicationPeriod = "정보 없음",
            applicationStartDate = null, applicationEndDate = null).let {
                it.copy(program = it.program.copy(status = SupportProgramStatus.UNKNOWN))
            }
        repository.synchronizeSource(source, listOf(notice, notice.copy(program = notice.program.copy(id = "missing"))))
        val index = Mockito.mock(SupportProgramIndexSyncService::class.java)

        repeat(2) {
            assertEquals(1, syncNotice(source, SupportProgramCatalogFacade { listOf(notice) }, index))
            assertEquals(notice, repository.findPresentBySourceAndProgramId(source, "shared"))
            assertEquals(listOf(notice), repository.findSearchablePresent())
            assertFalse(isSourcePresent(source, "missing"))
            assertEquals(2, countRows(source))
            others.forEach { assertEquals(it, repository.findPresentBySourceAndProgramId(it.program.sourceCode, "shared")) }
        }
    }

    @ParameterizedTest
    @ValueSource(strings = ["MSIT", "CNTRADE_NOTICE"])
    fun incompleteNoticeCollectionOrIndexFailurePreservesEveryPublishedSource(source: String) {
        val original = catalogProgram("shared", "기존 원문", sourceCode = source)
        val bizinfo = catalogProgram("shared", "기업마당 원문")
        for (entry in listOf(original, bizinfo)) {
            val generation = repository.startSyncGeneration(entry.program.sourceCode)
            repository.publishSnapshotIfCurrent(entry.program.sourceCode, listOf(entry), generation)
        }
        val before = repository.findSearchablePresent()
        val bizinfoStatus = repository.findSyncStatus("BIZINFO")
        val index = Mockito.mock(SupportProgramIndexSyncService::class.java)

        assertThrows(IllegalStateException::class.java) {
            syncNotice(source, SupportProgramCatalogFacade { throw IllegalStateException("second page failed") }, index)
        }
        Mockito.verifyNoInteractions(index)
        val updated = listOf(original.copy(program = original.program.copy(title = "미공개 변경")))
        Mockito.doThrow(IllegalStateException("second index batch failed")).`when`(index).indexSnapshot(updated)
        assertThrows(IllegalStateException::class.java) {
            syncNotice(source, SupportProgramCatalogFacade { updated }, index)
        }

        assertEquals(before, repository.findSearchablePresent())
        assertEquals(bizinfoStatus, repository.findSyncStatus("BIZINFO"))
        assertEquals(SupportProgramSyncOutcome.FAILURE, repository.findSyncStatus(source)?.lastSyncOutcome)
    }

    @ParameterizedTest
    @ValueSource(strings = ["MSIT", "CNTRADE_NOTICE"])
    fun failedNoticePublicationRollsBackTheSourceSnapshot(source: String) {
        val original = catalogProgram("shared", "기존 공고", sourceCode = source)
        repository.publishSnapshotIfCurrent(source, listOf(original), repository.startSyncGeneration(source))
        val statusBefore = repository.findSyncStatus(source)
        val next = repository.startSyncGeneration(source)
        val invalid = catalogProgram("invalid", "가".repeat(501), sourceCode = source)

        assertThrows(DataAccessException::class.java) {
            repository.publishSnapshotIfCurrent(source,
                listOf(original.copy(program = original.program.copy(title = "롤백할 변경")), invalid), next)
        }

        assertEquals(listOf(original), repository.findSearchablePresent())
        assertEquals(statusBefore, repository.findSyncStatus(source))
        assertEquals(0, countRowsByProgramId(source, "invalid"))
    }

    private fun syncNotice(source: String, facade: SupportProgramCatalogFacade, index: SupportProgramIndexSyncService): Int? =
        when (source) {
            "MSIT" -> MsitSupportProgramCatalogSyncService(facade, repository, index, publicationService).sync()
            "CNTRADE_NOTICE" -> CnTradeNoticeSupportProgramCatalogSyncService(facade, repository, index, publicationService).sync()
            else -> error("Unexpected test source")
        }

    private fun countRows(sourceCode: String): Int =
        requireNotNull(
            jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM support_program WHERE source_code = ?",
                Int::class.java,
                sourceCode,
            ),
        )

    private fun countPresentRows(sourceCode: String): Int =
        requireNotNull(
            jdbcTemplate.queryForObject(
                """
                SELECT COUNT(*)
                FROM support_program
                WHERE source_code = ?
                  AND is_source_present = TRUE
                """.trimIndent(),
                Int::class.java,
                sourceCode,
            ),
        )

    private fun countRowsByProgramId(sourceCode: String, sourceProgramId: String): Int =
        requireNotNull(
            jdbcTemplate.queryForObject(
                """
                SELECT COUNT(*)
                FROM support_program
                WHERE source_code = ?
                  AND source_program_id = ?
                """.trimIndent(),
                Int::class.java,
                sourceCode,
                sourceProgramId,
            ),
        )

    private fun countSourceDocumentRows(sourceCode: String, sourceProgramId: String): Int =
        requireNotNull(
            jdbcTemplate.queryForObject(
                """
                SELECT COUNT(*)
                FROM support_program_source_document
                WHERE source_code = ?
                  AND source_program_id = ?
                """.trimIndent(),
                Int::class.java,
                sourceCode,
                sourceProgramId,
            ),
        )

    private fun isSourcePresent(sourceCode: String, sourceProgramId: String): Boolean =
        requireNotNull(
            jdbcTemplate.queryForObject(
                """
                SELECT is_source_present
                FROM support_program
                WHERE source_code = ?
                  AND source_program_id = ?
                """.trimIndent(),
                Boolean::class.java,
                sourceCode,
                sourceProgramId,
            ),
        )

    private fun insertProgram(sourceCode: String, sourceProgramId: String, title: String) {
        jdbcTemplate.update(
            """
            INSERT INTO support_program (
                source_code,
                source_program_id,
                title,
                organization,
                summary,
                categories,
                regions,
                target_description,
                application_period_raw,
                source_url
            ) VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?)
            """.trimIndent(),
            sourceCode,
            sourceProgramId,
            title,
            "다른 수행기관",
            "다른 제공처의 공고입니다.",
            "[]",
            "[]",
            "중소기업",
            "상시 접수",
            "https://example.com/program/$sourceProgramId",
        )
    }

    private fun catalogProgram(
        id: String,
        title: String,
        sourceCode: String = "BIZINFO",
        categories: List<String> = listOf("AI"),
        regions: List<String> = listOf("서울"),
        applicationPeriod: String = "2000-01-01 ~ 9999-12-31",
        applicationStartDate: LocalDate? = LocalDate.of(2000, 1, 1),
        applicationEndDate: LocalDate? = LocalDate.of(9999, 12, 31),
    ) = CatalogSupportProgram(
        program = SupportProgram(
            id = id,
            sourceCode = sourceCode,
            title = title,
            organization = "수행기관",
            summary = "중소기업의 AI 기술 활용을 지원합니다.",
            categories = categories,
            regions = regions,
            targetDescription = "중소기업",
            applicationPeriod = applicationPeriod,
            applicationStartDate = applicationStartDate,
            applicationEndDate = applicationEndDate,
            status = SupportProgramStatus.OPEN,
            sourceName = when (sourceCode) {
                "BIZINFO" -> "기업마당"
                "KSTARTUP" -> "K-Startup"
                "MSIT" -> "과학기술정보통신부"
                "CNTRADE_NOTICE" -> "충청남도 온라인수출지원시스템"
                else -> sourceCode
            },
            sourceUrl = when (sourceCode) {
                "BIZINFO" -> "https://www.bizinfo.go.kr/detail?id=$id"
                "KSTARTUP" -> "https://www.k-startup.go.kr/detail?id=$id"
                "MSIT" -> "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=$id"
                "CNTRADE_NOTICE" -> "https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do"
                else -> "https://example.com/program/$id"
            },
            matchedReasons = emptyList(),
        ),
        sortTimestamp = "2026-08-21 14:19:54",
    )
}
