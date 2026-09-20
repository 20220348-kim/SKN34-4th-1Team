package ai.govbiz.core.supportprogram.service.sync

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class BizInfoSupportProgramCatalogSyncSchedulerTest {

    @Mock
    private lateinit var syncService: BizInfoSupportProgramCatalogSyncService

    @Test
    fun invokesTheSyncService() {
        doReturn(3).`when`(syncService).sync()

        scheduler().synchronize()

        verify(syncService).sync()
    }

    @Test
    fun acceptsASupersededSyncWithoutTreatingItAsAFailure() {
        doReturn(null).`when`(syncService).sync()

        scheduler().synchronize()

        verify(syncService).sync()
    }

    @Test
    fun continuesWithTheNextScheduledRunAfterASyncFailure() {
        doThrow(IllegalStateException("sync failed"))
            .doReturn(2)
            .`when`(syncService)
            .sync()

        val scheduler = scheduler()
        scheduler.synchronize()
        scheduler.synchronize()

        verify(syncService, times(2)).sync()
    }

    private fun scheduler() = BizInfoSupportProgramCatalogSyncScheduler(syncService)
}
