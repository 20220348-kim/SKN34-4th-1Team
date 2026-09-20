package ai.govbiz.core.supportprogram.service.sync

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.sync.config.SupportProgramCatalogSyncOnceProperties
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.mockito.Mockito.*

class SupportProgramCatalogSyncOnceServiceTest {
    @TempDir lateinit var directory: Path
    private val repository = mock(SupportProgramRepository::class.java)
    private val index = mock(SupportProgramIndexSyncService::class.java)
    private val unused = SupportProgramCatalogFacade { error("unselected source called") }

    @Test
    fun dryRunCollectsSelectedSourcesWithoutWritingOrCallingAi() {
        service().run(properties(apply = false))
        verifyNoInteractions(repository, index)
        assertFalse(Files.exists(directory.resolve("receipt")))
    }

    @Test
    fun overBudgetStopsBeforeReceiptDatabaseAndPaidCalls() {
        assertThrows(IllegalStateException::class.java) {
            service().run(properties().copy(maxUsd = BigDecimal("0.00000001")))
        }
        verifyNoInteractions(repository, index)
        assertFalse(Files.exists(directory.resolve("receipt")))
    }

    @Test
    fun collectsEverySelectedSourceBeforeIndexingAndNeverReloadsAfterBudgetCheck() {
        var loads = 0
        val snapshot = listOf(program())
        val first = SupportProgramCatalogFacade { loads++; snapshot }
        val second = SupportProgramCatalogFacade { error("later source collection failed") }
        assertThrows(IllegalStateException::class.java) {
            SupportProgramCatalogSyncOnceService(first, second, unused, unused, repository, index, ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogPublicationService(repository, org.mockito.Mockito.mock(ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository::class.java)))
                .run(properties().copy(sources = listOf("BIZINFO", "KSTARTUP")))
        }
        assertEquals(1, loads)
        verifyNoInteractions(repository, index)
    }

    @Test
    fun publishesOnceAndPersistentReceiptBlocksEverySubsequentAttempt() {
        var loads = 0
        val snapshot = listOf(program())
        val facade = SupportProgramCatalogFacade { loads++; snapshot }
        `when`(repository.startSyncGeneration("BIZINFO")).thenReturn(1)
        `when`(index.indexSnapshot(snapshot)).thenAnswer {
            assertTrue(Files.readString(directory.resolve("receipt")).startsWith("RESERVED"))
            1
        }
        `when`(repository.publishSnapshotIfCurrent("BIZINFO", snapshot, 1)).thenReturn(true)
        val service = SupportProgramCatalogSyncOnceService(facade, unused, unused, unused, repository, index, ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogPublicationService(repository, org.mockito.Mockito.mock(ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository::class.java)))
        service.run(properties())
        assertTrue(Files.readString(directory.resolve("receipt")).endsWith("COMPLETED\n"))
        assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(directory.resolve("receipt"))))
        assertThrows(IllegalStateException::class.java) { service.run(properties()) }
        assertEquals(1, loads)
        inOrder(repository, index).apply {
            verify(repository).startSyncGeneration("BIZINFO")
            verify(index).indexSnapshot(snapshot)
            verify(repository).publishSnapshotIfCurrent("BIZINFO", snapshot, 1)
            verifyNoMoreInteractions()
        }
    }

    @Test
    fun failedIndexKeepsReservationAndDoesNotPublishOrRetry() {
        val snapshot = listOf(program())
        `when`(repository.startSyncGeneration("BIZINFO")).thenReturn(1)
        `when`(index.indexSnapshot(snapshot)).thenThrow(IllegalStateException("timeout after possible charge"))
        assertThrows(IllegalStateException::class.java) { service().run(properties()) }
        assertThrows(IllegalStateException::class.java) { service().run(properties()) }
        verify(repository).recordSyncFailureIfCurrent("BIZINFO", 1)
        verify(repository, never()).publishSnapshotIfCurrent("BIZINFO", snapshot, 1)
        verify(index, times(1)).indexSnapshot(snapshot)
        assertFalse(Files.readString(directory.resolve("receipt")).contains("COMPLETED"))
    }

    @Test
    fun rejectsDuplicateIdsAndCrossSourceSnapshotsBeforePayment() {
        for (snapshot in listOf(listOf(program(), program()), listOf(program().let { it.copy(program = it.program.copy(sourceCode = "MSIT")) }))) {
            assertThrows(IllegalStateException::class.java) { service(snapshot).run(properties()) }
        }
        verifyNoInteractions(repository, index)
    }

    @Test
    fun validatesExplicitBudgetSourcesAndAbsoluteReceiptPath() {
        for (budget in listOf("0", "-1", "1.01")) {
            assertThrows(IllegalArgumentException::class.java) { properties().copy(maxUsd = BigDecimal(budget)) }
        }
        for (sources in listOf(emptyList(), listOf("BIZINFO", "BIZINFO"), listOf("UNKNOWN"))) {
            assertThrows(IllegalArgumentException::class.java) { properties().copy(sources = sources) }
        }
        assertThrows(IllegalArgumentException::class.java) { properties().copy(receiptPath = Path.of("relative")) }
    }

    @Test
    fun longUnicodeInputUsesTheSamePerDocumentTokenCeilingAsAiService() {
        val snapshot = listOf(program().let { it.copy(program = it.program.copy(summary = "한글🚀".repeat(12000))) })
        `when`(repository.startSyncGeneration("BIZINFO")).thenReturn(1)
        `when`(index.indexSnapshot(snapshot)).thenReturn(1)
        `when`(repository.publishSnapshotIfCurrent("BIZINFO", snapshot, 1)).thenReturn(true)
        service(snapshot).run(properties().copy(maxUsd = BigDecimal("0.00016382")))
        assertTrue(Files.readString(directory.resolve("receipt")).contains("upperBoundUsd=0.00016382"))
    }

    @Test
    fun exclusiveCreationAlsoRejectsAReceiptCreatedDuringCollection() {
        val facade = SupportProgramCatalogFacade {
            Files.writeString(directory.resolve("receipt"), "other run reserved")
            listOf(program())
        }
        val service = SupportProgramCatalogSyncOnceService(facade, unused, unused, unused, repository, index, ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogPublicationService(repository, org.mockito.Mockito.mock(ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository::class.java)))
        assertThrows(java.nio.file.FileAlreadyExistsException::class.java) { service.run(properties()) }
        verifyNoInteractions(repository, index)
        assertEquals("other run reserved", Files.readString(directory.resolve("receipt")))
    }

    private fun service(snapshot: List<CatalogSupportProgram> = listOf(program())) =
        SupportProgramCatalogSyncOnceService(SupportProgramCatalogFacade { snapshot }, unused, unused, unused, repository, index, ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogPublicationService(repository, org.mockito.Mockito.mock(ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository::class.java)))

    private fun properties(apply: Boolean = true) =
        SupportProgramCatalogSyncOnceProperties(listOf("BIZINFO"), BigDecimal.ONE, directory.resolve("receipt"), apply)

    private fun program() = CatalogSupportProgram(
        program = SupportProgram("id", "BIZINFO", "한글 지원사업 🚀", "기관", "요약", listOf("AI"), listOf("전국"),
            "중소기업", "상시 접수", null, null, SupportProgramStatus.OPEN, "기업마당", "https://www.bizinfo.go.kr/", emptyList(), null),
        sortTimestamp = "2026-09-15 00:00:00",
    )
}
