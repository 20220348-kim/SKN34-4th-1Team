package ai.govbiz.core.supportprogram.service.sync

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.core.supportprogram.facade.exception.SupportProgramCatalogFacadeException
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.inOrder
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.Mockito.verifyNoMoreInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class BizInfoSupportProgramCatalogSyncServiceTest {

    @Mock
    private lateinit var catalogFacade: SupportProgramCatalogFacade

    @Mock
    private lateinit var supportProgramRepository: SupportProgramRepository
    @Mock
    private lateinit var indexSyncService: SupportProgramIndexSyncService

    @Test
    fun indexesTheWholeSnapshotBeforePublishingItToTheRepository() {
        val programs = listOf(catalogProgram("first"), catalogProgram("second"))
        doReturn(7L).`when`(supportProgramRepository).startSyncGeneration("BIZINFO")
        doReturn(programs).`when`(catalogFacade).load()
        doReturn(2).`when`(indexSyncService).indexSnapshot(programs)
        doReturn(true).`when`(supportProgramRepository).publishSnapshotIfCurrent("BIZINFO", programs, 7L)

        val synchronizedCount = service().sync()

        assertEquals(2, synchronizedCount)
        inOrder(supportProgramRepository, catalogFacade, indexSyncService).apply {
            verify(supportProgramRepository).startSyncGeneration("BIZINFO")
            verify(catalogFacade).load()
            verify(indexSyncService).indexSnapshot(programs)
            verify(supportProgramRepository).publishSnapshotIfCurrent("BIZINFO", programs, 7L)
            verifyNoMoreInteractions()
        }
    }

    @Test
    fun doesNotPublishTheRepositoryWhenCatalogCollectionFails() {
        val failure = SupportProgramCatalogFacadeException.fromClient(
            failure = SupportProgramCatalogFacadeException.Failure.UPSTREAM_ERROR,
            message = "기업마당 지원사업 목록 수집 실패",
            cause = IllegalStateException("upstream failure"),
        )
        doReturn(8L).`when`(supportProgramRepository).startSyncGeneration("BIZINFO")
        doThrow(failure).`when`(catalogFacade).load()

        val thrown = assertThrows(SupportProgramCatalogFacadeException::class.java) {
            service().sync()
        }

        assertSame(failure, thrown)
        verify(supportProgramRepository).startSyncGeneration("BIZINFO")
        verify(supportProgramRepository).recordSyncFailureIfCurrent("BIZINFO", 8L)
        verifyNoInteractions(indexSyncService)
    }

    @Test
    fun doesNotPublishTheRepositoryWhenVectorPreparationFails() {
        val programs = listOf(catalogProgram("first"))
        val failure = IllegalStateException("index unavailable")
        doReturn(9L).`when`(supportProgramRepository).startSyncGeneration("BIZINFO")
        doReturn(programs).`when`(catalogFacade).load()
        doThrow(failure).`when`(indexSyncService).indexSnapshot(programs)

        assertSame(failure, assertThrows(IllegalStateException::class.java) { service().sync() })

        verify(supportProgramRepository).startSyncGeneration("BIZINFO")
        verify(supportProgramRepository).recordSyncFailureIfCurrent("BIZINFO", 9L)
        verifyNoMoreInteractions(supportProgramRepository)
    }

    @Test
    fun doesNotPublishOrPruneWhenANewerSyncStartedDuringVectorPreparation() {
        val programs = listOf(catalogProgram("first"))
        doReturn(10L).`when`(supportProgramRepository).startSyncGeneration("BIZINFO")
        doReturn(programs).`when`(catalogFacade).load()
        doReturn(1).`when`(indexSyncService).indexSnapshot(programs)
        doReturn(false).`when`(supportProgramRepository).publishSnapshotIfCurrent("BIZINFO", programs, 10L)

        assertNull(service().sync())

        verify(supportProgramRepository).publishSnapshotIfCurrent("BIZINFO", programs, 10L)
        verify(supportProgramRepository, never()).recordSyncFailureIfCurrent("BIZINFO", 10L)
    }

    private fun service() = BizInfoSupportProgramCatalogSyncService(
        catalogFacade = catalogFacade,
        supportProgramRepository = supportProgramRepository,
        indexSyncService = indexSyncService, publicationService = ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogPublicationService(supportProgramRepository, org.mockito.Mockito.mock(ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository::class.java)))

    private fun catalogProgram(id: String) = CatalogSupportProgram(
        program = SupportProgram(
            id = id,
            sourceCode = "BIZINFO",
            title = "$id 지원사업",
            organization = "수행기관",
            summary = "지원 내용",
            categories = listOf("AI"),
            regions = listOf("서울"),
            targetDescription = "중소기업",
            applicationPeriod = "상시 접수",
            applicationStartDate = null,
            applicationEndDate = null,
            status = SupportProgramStatus.OPEN,
            sourceName = "기업마당",
            sourceUrl = "https://www.bizinfo.go.kr/detail?id=$id",
            matchedReasons = emptyList(),
            recommendationScore = null,
        ),
        sortTimestamp = "2026-09-04 10:00:00",
    )
}
