package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentGenerationJobRepository
import java.time.Duration
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*

class ApplicationDocumentGenerationJobWorkerTest {
    private val jobs = mock(ApplicationDocumentGenerationJobRepository::class.java)
    private val service = mock(ApplicationDocumentGenerationJobService::class.java)
    private val executor = mock(ThreadPoolExecutor::class.java)
    private val ttl = Duration.ofHours(24)
    private val worker = ApplicationDocumentGenerationJobWorker(jobs, service, executor, 1, ttl)

    @Test
    fun rejectedExecutorSubmissionReleasesTheSlotForTheNextPoll() {
        `when`(jobs.claimable(1)).thenReturn(listOf(7L))
        `when`(service.execute(7L)).thenReturn(true)
        doThrow(RejectedExecutionException("executor unavailable")).doAnswer { invocation ->
            invocation.getArgument<Runnable>(0).run()
            null
        }.`when`(executor).execute(any(Runnable::class.java))

        worker.poll()
        worker.poll()

        verify(jobs, times(2)).expireStaleWork(ttl)
        verify(jobs, times(2)).claimable(1)
        verify(service).execute(7L)
    }

    @Test
    fun pendingExecutionDoesNotStopExpiryAndItsSlotIsReleasedAfterCompletion() {
        val pending = mutableListOf<Runnable>()
        `when`(jobs.claimable(1)).thenReturn(listOf(7L))
        `when`(jobs.claimable(0)).thenReturn(emptyList())
        `when`(service.execute(7L)).thenReturn(true)
        doAnswer { invocation -> pending.add(invocation.getArgument(0)); null }.`when`(executor).execute(any(Runnable::class.java))

        worker.poll()
        worker.poll()
        assertEquals(1, pending.size)
        verify(jobs, times(2)).expireStaleWork(ttl)
        verify(jobs).claimable(0)
        verifyNoInteractions(service)

        pending.single().run()
        worker.poll()
        verify(jobs, times(2)).claimable(1)
        verify(service).execute(7L)
    }
}
