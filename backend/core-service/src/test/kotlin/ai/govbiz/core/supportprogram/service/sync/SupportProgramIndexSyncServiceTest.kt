package ai.govbiz.core.supportprogram.service.sync

import ai.govbiz.core.supportprogram.client.elasticsearch.ElasticsearchSupportProgramClient
import ai.govbiz.core.supportprogram.client.elasticsearch.mapper.ElasticsearchSupportProgramDocumentMapper
import ai.govbiz.core.supportprogram.client.elasticsearch.exception.ElasticsearchClientException
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramIndexClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexBatchPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexBatchRequest
import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncOutcome
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.inOrder
import org.mockito.Mockito.never
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class SupportProgramIndexSyncServiceTest {
    @Mock
    private lateinit var repository: SupportProgramRepository
    @Mock
    private lateinit var client: AiSupportProgramIndexClient
    @Mock
    private lateinit var lexicalClient: ElasticsearchSupportProgramClient
    private val programs = (1..17).map { catalogProgram("program-$it") }
    private val documents = programs.map(SupportProgramIndexDocumentMapper::fromCatalog)
    private val firstBatch = AiSupportProgramIndexBatchRequest(documents.take(16))
    private val lastBatch = AiSupportProgramIndexBatchRequest(documents.drop(16))

    @Test
    fun indexesAllBatchesAndIsSafeToRepeat() {
        doReturn(AiSupportProgramIndexBatchPayload(16)).`when`(client).indexBatch(firstBatch)
        doReturn(AiSupportProgramIndexBatchPayload(1)).`when`(client).indexBatch(lastBatch)
        val service = SupportProgramIndexSyncService(repository, client, lexicalClient)

        assertEquals(17, service.indexSnapshot(programs))
        assertEquals(17, service.indexSnapshot(programs))

        val order = inOrder(lexicalClient, client)
        repeat(2) {
            order.verify(lexicalClient).indexSnapshot(programs.map(ElasticsearchSupportProgramDocumentMapper::fromCatalog))
            order.verify(client).indexBatch(firstBatch)
            order.verify(client).indexBatch(lastBatch)
        }
    }

    @Test
    fun indexesProgramsFromDifferentSourcesWithTheSameRawId() {
        val bizInfo = catalogProgram("SHARED")
        val other = bizInfo.copy(
            program = bizInfo.program.copy(
                sourceCode = "OTHER",
                sourceName = "다른 제공처",
                sourceUrl = "https://other.example/program/SHARED",
            ),
        )
        val snapshot = listOf(bizInfo, other)
        val request = AiSupportProgramIndexBatchRequest(
            snapshot.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        doReturn(AiSupportProgramIndexBatchPayload(2)).`when`(client).indexBatch(request)
        val service = SupportProgramIndexSyncService(repository, client, lexicalClient)

        assertEquals(2, service.indexSnapshot(snapshot))
        verify(client).indexBatch(request)
    }

    @Test
    fun lexicalFailureDoesNotCallVectorIndexOrPublishReadiness() {
        doThrow(ElasticsearchClientException("partial index")).`when`(lexicalClient)
            .indexSnapshot(programs.map(ElasticsearchSupportProgramDocumentMapper::fromCatalog))
        assertThrows(ElasticsearchClientException::class.java) {
            SupportProgramIndexSyncService(repository, client, lexicalClient).indexSnapshot(programs)
        }
        verifyNoInteractions(client, repository)
    }

    @Test
    fun failedLaterBatchDoesNotPublishACompleteIndexAndNextRepairRetriesTheSnapshot() {
        doReturn(programs).`when`(repository).findPresent()
        doReturn(AiSupportProgramIndexBatchPayload(16)).`when`(client).indexBatch(firstBatch)
        doThrow(AiServiceCallException.unavailable(null)).doReturn(AiSupportProgramIndexBatchPayload(1))
            .`when`(client).indexBatch(lastBatch)
        val scheduler = SupportProgramIndexSyncScheduler(SupportProgramIndexSyncService(repository, client, lexicalClient))

        scheduler.synchronize()
        scheduler.synchronize()

        verify(client, times(2)).indexBatch(firstBatch)
        verify(client, times(2)).indexBatch(lastBatch)
    }

    @Test
    fun refusesToAcceptAPartialBatchAcknowledgement() {
        doReturn(AiSupportProgramIndexBatchPayload(15)).`when`(client).indexBatch(firstBatch)

        assertThrows(AiServiceCallException::class.java) {
            SupportProgramIndexSyncService(repository, client, lexicalClient).indexSnapshot(programs)
        }

        verify(client, never()).indexBatch(lastBatch)
    }

    @Test
    fun emptyCatalogNeedsNoEmbeddingCall() {
        doReturn(emptyList<CatalogSupportProgram>()).`when`(repository).findPresent()

        assertEquals(0, SupportProgramIndexSyncService(repository, client, lexicalClient).repair())
        verifyNoInteractions(client)
        verify(repository, never()).bootstrapLegacySnapshotAfterSuccessfulRepair(
            "BIZINFO", emptyList(),
        )
    }

    @Test
    fun bootstrapsANonemptyLegacySnapshotOnlyAfterItsFullRepairSucceeds() {
        val snapshot = listOf(catalogProgram("legacy-program"))
        val request = AiSupportProgramIndexBatchRequest(
            snapshot.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        doReturn(snapshot).`when`(repository).findPresent()
        doReturn(emptyList<SupportProgramSyncStatus>()).`when`(repository).findSyncStatuses()
        doReturn(AiSupportProgramIndexBatchPayload(1)).`when`(client).indexBatch(request)
        doReturn(true).`when`(repository).bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", snapshot)

        assertEquals(1, SupportProgramIndexSyncService(repository, client, lexicalClient).repair())

        verify(repository).bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", snapshot)
    }

    @Test
    fun doesNotBootstrapALegacySnapshotWhenItsRepairFails() {
        val snapshot = listOf(catalogProgram("legacy-failed-repair-program"))
        val request = AiSupportProgramIndexBatchRequest(
            snapshot.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        doReturn(snapshot).`when`(repository).findPresent()
        doReturn(emptyList<SupportProgramSyncStatus>()).`when`(repository).findSyncStatuses()
        doThrow(AiServiceCallException.unavailable(null)).`when`(client).indexBatch(request)

        assertThrows(AiServiceCallException::class.java) {
            SupportProgramIndexSyncService(repository, client, lexicalClient).repair()
        }

        verify(repository, never()).bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", snapshot)
    }

    @Test
    fun marksTheStoredPublishedSnapshotReadyOnlyAfterItsFullRepairSucceeds() {
        val snapshot = listOf(catalogProgram("ready-program"))
        val request = AiSupportProgramIndexBatchRequest(
            snapshot.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        val fingerprint = SupportProgramCatalogFingerprintHelper.calculate(snapshot)
        doReturn(snapshot).`when`(repository).findPresent()
        doReturn(listOf(status(generation = 31L, fingerprint = fingerprint, programCount = 1)))
            .`when`(repository).findSyncStatuses()
        doReturn(AiSupportProgramIndexBatchPayload(1)).`when`(client).indexBatch(request)

        assertEquals(1, SupportProgramIndexSyncService(repository, client, lexicalClient).repair())

        verify(repository).markIndexReadyIfPublishedSnapshotMatches("BIZINFO", 31L, fingerprint, 1)
        verify(repository, never()).markIndexNotReadyIfPublishedSnapshotMatches(
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyLong(),
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyInt(),
        )
        verify(repository, never()).bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", snapshot)
    }

    @Test
    fun marksOnlyTheSamePublishedSnapshotNotReadyWhenItsRepairFails() {
        val snapshot = listOf(catalogProgram("failed-repair-program"))
        val request = AiSupportProgramIndexBatchRequest(
            snapshot.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        val fingerprint = SupportProgramCatalogFingerprintHelper.calculate(snapshot)
        val failure = AiServiceCallException.unavailable(null)
        doReturn(snapshot).`when`(repository).findPresent()
        doReturn(listOf(status(generation = 32L, fingerprint = fingerprint, programCount = 1)))
            .`when`(repository).findSyncStatuses()
        doThrow(failure).`when`(client).indexBatch(request)
        doReturn(false).`when`(repository).markIndexNotReadyIfPublishedSnapshotMatches("BIZINFO", 32L, fingerprint, 1)

        assertEquals(
            failure,
            assertThrows(AiServiceCallException::class.java) {
                SupportProgramIndexSyncService(repository, client, lexicalClient).repair()
            },
        )

        verify(repository).markIndexNotReadyIfPublishedSnapshotMatches("BIZINFO", 32L, fingerprint, 1)
        verify(repository, never()).markIndexReadyIfPublishedSnapshotMatches(
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyLong(),
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyInt(),
        )
        verify(repository, never()).bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", snapshot)
    }

    @Test
    fun doesNotChangeReadinessWhenThePublishedMetadataDoesNotMatchTheSnapshotItIndexed() {
        val snapshot = listOf(catalogProgram("stale-repair-program"))
        val request = AiSupportProgramIndexBatchRequest(
            snapshot.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        doReturn(snapshot).`when`(repository).findPresent()
        doReturn(listOf(status(generation = 33L, fingerprint = "f".repeat(64), programCount = 1)))
            .`when`(repository).findSyncStatuses()
        doReturn(AiSupportProgramIndexBatchPayload(1)).`when`(client).indexBatch(request)

        assertEquals(1, SupportProgramIndexSyncService(repository, client, lexicalClient).repair())

        verify(repository, never()).markIndexReadyIfPublishedSnapshotMatches(
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyLong(),
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyInt(),
        )
        verify(repository, never()).markIndexNotReadyIfPublishedSnapshotMatches(
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyLong(),
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.anyInt(),
        )
        verify(repository, never()).bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", snapshot)
    }

    @ParameterizedTest
    @ValueSource(strings = ["BIZINFO", "OTHER"])
    fun failedSourceDoesNotBlockAnotherSourceWithTheSameRawProgramId(failedSource: String) {
        val successfulSource = if (failedSource == "BIZINFO") "OTHER" else "BIZINFO"
        val failedPrograms = listOf(programForSource("SHARED", failedSource))
        val successfulPrograms = listOf(programForSource("SHARED", successfulSource))
        val failedFingerprint = SupportProgramCatalogFingerprintHelper.calculate(failedPrograms)
        val successfulFingerprint = SupportProgramCatalogFingerprintHelper.calculate(successfulPrograms)
        val failedRequest = AiSupportProgramIndexBatchRequest(
            failedPrograms.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        val successfulRequest = AiSupportProgramIndexBatchRequest(
            successfulPrograms.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        val failure = AiServiceCallException.unavailable(null)
        val statusFailure = IllegalStateException("cannot record the failed source status")
        doReturn(failedPrograms + successfulPrograms).`when`(repository).findPresent()
        doReturn(
            listOf(
                status(41L, failedFingerprint, 1, failedSource),
                status(42L, successfulFingerprint, 1, successfulSource),
            ),
        ).`when`(repository).findSyncStatuses()
        doThrow(failure).`when`(client).indexBatch(failedRequest)
        doThrow(statusFailure).`when`(repository)
            .markIndexNotReadyIfPublishedSnapshotMatches(failedSource, 41L, failedFingerprint, 1)
        doReturn(AiSupportProgramIndexBatchPayload(1)).`when`(client).indexBatch(successfulRequest)

        val thrown = assertThrows(AiServiceCallException::class.java) {
            SupportProgramIndexSyncService(repository, client, lexicalClient).repair()
        }

        assertEquals(failure, thrown)
        assertEquals(listOf(statusFailure), thrown.suppressed.toList())
        val order = inOrder(repository, client)
        order.verify(client).indexBatch(failedRequest)
        order.verify(repository).markIndexNotReadyIfPublishedSnapshotMatches(failedSource, 41L, failedFingerprint, 1)
        order.verify(client).indexBatch(successfulRequest)
        order.verify(repository)
            .markIndexReadyIfPublishedSnapshotMatches(successfulSource, 42L, successfulFingerprint, 1)
        verify(repository, never()).markIndexReadyIfPublishedSnapshotMatches(failedSource, 41L, failedFingerprint, 1)
        verify(repository, never())
            .markIndexNotReadyIfPublishedSnapshotMatches(successfulSource, 42L, successfulFingerprint, 1)
    }

    @Test
    fun reportsAllSourceFailuresAfterAttemptingEverySource() {
        val bizInfoPrograms = listOf(catalogProgram("SHARED"))
        val otherPrograms = listOf(programForSource("SHARED", "OTHER"))
        val bizInfoFingerprint = SupportProgramCatalogFingerprintHelper.calculate(bizInfoPrograms)
        val otherFingerprint = SupportProgramCatalogFingerprintHelper.calculate(otherPrograms)
        val bizInfoFailure = AiServiceCallException.unavailable(null)
        val otherFailure = AiServiceCallException.invalidResponse("incomplete acknowledgement", null)
        doReturn(bizInfoPrograms + otherPrograms).`when`(repository).findPresent()
        doReturn(
            listOf(status(51L, bizInfoFingerprint, 1), status(52L, otherFingerprint, 1, "OTHER")),
        ).`when`(repository).findSyncStatuses()
        doThrow(bizInfoFailure).`when`(client).indexBatch(
            AiSupportProgramIndexBatchRequest(bizInfoPrograms.map(SupportProgramIndexDocumentMapper::fromCatalog)),
        )
        doThrow(otherFailure).`when`(client).indexBatch(
            AiSupportProgramIndexBatchRequest(otherPrograms.map(SupportProgramIndexDocumentMapper::fromCatalog)),
        )

        val thrown = assertThrows(AiServiceCallException::class.java) {
            SupportProgramIndexSyncService(repository, client, lexicalClient).repair()
        }

        assertEquals(bizInfoFailure, thrown)
        assertEquals(listOf(otherFailure), thrown.suppressed.toList())
        verify(repository).markIndexNotReadyIfPublishedSnapshotMatches("BIZINFO", 51L, bizInfoFingerprint, 1)
        verify(repository).markIndexNotReadyIfPublishedSnapshotMatches("OTHER", 52L, otherFingerprint, 1)
    }

    @Test
    fun bootstrapsEachLegacySourceWithOnlyItsOwnSnapshot() {
        val bizInfoPrograms = listOf(catalogProgram("SHARED"))
        val otherPrograms = listOf(programForSource("SHARED", "OTHER"))
        val bizInfoRequest = AiSupportProgramIndexBatchRequest(
            bizInfoPrograms.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        val otherRequest = AiSupportProgramIndexBatchRequest(
            otherPrograms.map(SupportProgramIndexDocumentMapper::fromCatalog),
        )
        doReturn(bizInfoPrograms + otherPrograms).`when`(repository).findPresent()
        doReturn(AiSupportProgramIndexBatchPayload(1)).`when`(client).indexBatch(bizInfoRequest)
        doReturn(AiSupportProgramIndexBatchPayload(1)).`when`(client).indexBatch(otherRequest)

        assertEquals(2, SupportProgramIndexSyncService(repository, client, lexicalClient).repair())

        val order = inOrder(repository, client)
        order.verify(client).indexBatch(bizInfoRequest)
        order.verify(repository).bootstrapLegacySnapshotAfterSuccessfulRepair("BIZINFO", bizInfoPrograms)
        order.verify(client).indexBatch(otherRequest)
        order.verify(repository).bootstrapLegacySnapshotAfterSuccessfulRepair("OTHER", otherPrograms)
    }

    @Test
    fun marksEmptyPublishedSnapshotsReadyWithoutEmbeddingCalls() {
        val fingerprint = SupportProgramCatalogFingerprintHelper.calculate(emptyList())
        doReturn(emptyList<CatalogSupportProgram>()).`when`(repository).findPresent()
        doReturn(
            listOf(status(61L, fingerprint, 0), status(62L, fingerprint, 0, "OTHER")),
        ).`when`(repository).findSyncStatuses()

        assertEquals(0, SupportProgramIndexSyncService(repository, client, lexicalClient).repair())

        verifyNoInteractions(client)
        verify(repository).markIndexReadyIfPublishedSnapshotMatches("BIZINFO", 61L, fingerprint, 0)
        verify(repository).markIndexReadyIfPublishedSnapshotMatches("OTHER", 62L, fingerprint, 0)
    }

    @Test
    fun stillRepairsAnEmptyPublishedSourceWhenAnotherSourcesIndexingFails() {
        val snapshot = listOf(catalogProgram("failed-program"))
        val fingerprint = SupportProgramCatalogFingerprintHelper.calculate(snapshot)
        val emptyFingerprint = SupportProgramCatalogFingerprintHelper.calculate(emptyList())
        doReturn(snapshot).`when`(repository).findPresent()
        doReturn(
            listOf(status(71L, fingerprint, 1), status(72L, emptyFingerprint, 0, "OTHER")),
        ).`when`(repository).findSyncStatuses()
        doThrow(AiServiceCallException.unavailable(null)).`when`(client).indexBatch(
            AiSupportProgramIndexBatchRequest(snapshot.map(SupportProgramIndexDocumentMapper::fromCatalog)),
        )

        assertThrows(AiServiceCallException::class.java) {
            SupportProgramIndexSyncService(repository, client, lexicalClient).repair()
        }

        verify(repository).markIndexNotReadyIfPublishedSnapshotMatches("BIZINFO", 71L, fingerprint, 1)
        verify(repository).markIndexReadyIfPublishedSnapshotMatches("OTHER", 72L, emptyFingerprint, 0)
    }

    @Test
    fun keepsTheGlobalCatalogLimitWhenProgramsAreSplitAcrossSources() {
        val snapshot = (0..SupportProgramIndexDocumentMapper.MAX_DOCUMENTS).map { index ->
            programForSource("program-$index", if (index % 2 == 0) "BIZINFO" else "OTHER")
        }
        doReturn(snapshot).`when`(repository).findPresent()

        assertThrows(IllegalStateException::class.java) {
            SupportProgramIndexSyncService(repository, client, lexicalClient).repair()
        }

        verifyNoInteractions(client)
    }

    private fun programForSource(id: String, sourceCode: String): CatalogSupportProgram {
        val catalog = catalogProgram(id)
        return catalog.copy(program = catalog.program.copy(sourceCode = sourceCode, sourceName = sourceCode))
    }

    private fun status(
        generation: Long,
        fingerprint: String,
        programCount: Int,
        sourceCode: String = "BIZINFO",
    ) = SupportProgramSyncStatus(
        sourceCode = sourceCode,
        publishedGeneration = generation,
        publishedCatalogFingerprint = fingerprint,
        publishedProgramCount = programCount,
        indexReady = false,
        lastSuccessfulSyncAt = null,
        lastFailedSyncAt = null,
        lastSyncOutcome = SupportProgramSyncOutcome.SUCCESS,
    )
}
