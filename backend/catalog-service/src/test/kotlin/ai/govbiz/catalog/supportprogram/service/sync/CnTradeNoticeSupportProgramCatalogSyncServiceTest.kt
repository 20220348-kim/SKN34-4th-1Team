package ai.govbiz.catalog.supportprogram.service.sync

import ai.govbiz.catalog.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.catalog.supportprogram.domain.SupportProgram
import ai.govbiz.catalog.supportprogram.domain.SupportProgramStatus
import ai.govbiz.catalog.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.catalog.supportprogram.repository.SupportProgramRepository
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
class CnTradeNoticeSupportProgramCatalogSyncServiceTest {
    @Mock private lateinit var facade: SupportProgramCatalogFacade
    @Mock private lateinit var repository: SupportProgramRepository
    @Mock private lateinit var index: SupportProgramIndexSyncService

    @Test
    fun publishesOnlyTheCnTradeNoticeSnapshotAfterTheWholeCollectionAndIndexHaveSucceeded() {
        val programs = listOf(program("179197"), program("179198"))
        doReturn(7L).`when`(repository).startSyncGeneration("CNTRADE_NOTICE")
        doReturn(programs).`when`(facade).load()
        doReturn(true).`when`(repository).publishSnapshotIfCurrent("CNTRADE_NOTICE", programs, 7L)

        assertEquals(2, service().sync())

        inOrder(repository, facade, index).apply {
            verify(repository).startSyncGeneration("CNTRADE_NOTICE")
            verify(facade).load()
            verify(index).indexSnapshot(programs)
            verify(repository).publishSnapshotIfCurrent("CNTRADE_NOTICE", programs, 7L)
            verifyNoMoreInteractions()
        }
    }

    @Test
    fun collectionFailureRecordsOnlyItsSourceAndDoesNotIndexOrPublish() {
        val failure = IllegalStateException("page 2 failed")
        doReturn(8L).`when`(repository).startSyncGeneration("CNTRADE_NOTICE")
        doThrow(failure).`when`(facade).load()

        assertSame(failure, assertThrows(IllegalStateException::class.java) { service().sync() })

        verify(repository).startSyncGeneration("CNTRADE_NOTICE")
        verify(repository).recordSyncFailureIfCurrent("CNTRADE_NOTICE", 8L)
        verifyNoMoreInteractions(repository)
        verifyNoInteractions(index)
    }

    @Test
    fun indexFailureLeavesThePublishedSnapshotUntouched() {
        val programs = listOf(program("179197"))
        val failure = IllegalStateException("index failure")
        doReturn(9L).`when`(repository).startSyncGeneration("CNTRADE_NOTICE")
        doReturn(programs).`when`(facade).load()
        doThrow(failure).`when`(index).indexSnapshot(programs)

        assertSame(failure, assertThrows(IllegalStateException::class.java) { service().sync() })

        verify(repository).startSyncGeneration("CNTRADE_NOTICE")
        verify(repository).recordSyncFailureIfCurrent("CNTRADE_NOTICE", 9L)
        verifyNoMoreInteractions(repository)
    }

    @Test
    fun supersededSyncDoesNotRecordFailureOrPublishAnOlderGeneration() {
        val programs = listOf(program("179197"))
        doReturn(10L).`when`(repository).startSyncGeneration("CNTRADE_NOTICE")
        doReturn(programs).`when`(facade).load()
        doReturn(false).`when`(repository).publishSnapshotIfCurrent("CNTRADE_NOTICE", programs, 10L)

        assertNull(service().sync())

        verify(repository).publishSnapshotIfCurrent("CNTRADE_NOTICE", programs, 10L)
        verify(repository, never()).recordSyncFailureIfCurrent("CNTRADE_NOTICE", 10L)
    }

    @Test
    fun aVerifiedCompleteEmptyScopeCanPublishAnEmptySnapshot() {
        val programs = emptyList<CatalogSupportProgram>()
        doReturn(11L).`when`(repository).startSyncGeneration("CNTRADE_NOTICE")
        doReturn(programs).`when`(facade).load()
        doReturn(true).`when`(repository).publishSnapshotIfCurrent("CNTRADE_NOTICE", programs, 11L)

        assertEquals(0, service().sync())
        verify(index).indexSnapshot(programs)
        verify(repository).publishSnapshotIfCurrent("CNTRADE_NOTICE", programs, 11L)
    }

    @Test
    fun preservesTheOriginalFailureIfFailureRecordingAlsoFails() {
        val failure = IllegalStateException("original")
        val recordingFailure = IllegalArgumentException("recording")
        doReturn(12L).`when`(repository).startSyncGeneration("CNTRADE_NOTICE")
        doThrow(failure).`when`(facade).load()
        doThrow(recordingFailure).`when`(repository).recordSyncFailureIfCurrent("CNTRADE_NOTICE", 12L)

        val thrown = assertThrows(IllegalStateException::class.java) { service().sync() }
        assertSame(failure, thrown)
        assertEquals(listOf(recordingFailure), thrown.suppressed.toList())
    }

    private fun service() = CnTradeNoticeSupportProgramCatalogSyncService(facade, repository, index)

    private fun program(id: String) = CatalogSupportProgram(
        program = SupportProgram(
            id = id, sourceCode = "CNTRADE_NOTICE", title = "$id 창업 지원", organization = "기관", summary = "지원 내용",
            categories = listOf("사업화"), regions = listOf("전국"), targetDescription = "예비창업자",
            applicationPeriod = "정보 없음", applicationStartDate = null, applicationEndDate = null,
            status = SupportProgramStatus.UNKNOWN, sourceName = "충청남도 온라인수출지원시스템",
            sourceUrl = "https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do", matchedReasons = emptyList(),
        ), sortTimestamp = "",
    )
}
