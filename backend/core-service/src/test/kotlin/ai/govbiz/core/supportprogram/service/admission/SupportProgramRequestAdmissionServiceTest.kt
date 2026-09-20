package ai.govbiz.core.supportprogram.service.admission

import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException.Reason
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout

@Timeout(15)
class SupportProgramRequestAdmissionServiceTest {
    private val now = AtomicLong(0)

    @Test
    fun backgroundWorkSharesConcurrentCapacityWithoutChargingRateAgain() {
        val service = service(perClient = 1, global = 2, concurrent = 1)
        service.execute("client") {
            val failure = assertThrows(SupportProgramRequestRejectedException::class.java) { service.executeBackground {} }
            assertEquals(Reason.BUSY, failure.reason)
        }
        repeat(3) {
            service.executeBackground { assertEquals(Reason.BUSY, rejected(service, "other").reason) }
        }
        assertEquals("allowed", service.execute("other") { "allowed" })
        assertEquals(Reason.RATE_LIMITED, rejected(service, "client").reason)
    }

    @Test
    fun backgroundFailureReleasesTheSharedSlot() {
        val service = service(concurrent = 1)
        assertThrows(IllegalStateException::class.java) { service.executeBackground { error("failed") } }
        assertEquals("released", service.executeBackground { "released" })
        assertEquals("foreground", service.execute("client") { "foreground" })
    }

    @Test
    fun returnsTheActionResult() {
        assertEquals("result", service().execute("client") { "result" })
    }

    @Test
    fun rejectsTheSameClientWithoutRunningTheAction() {
        val service = service(perClient = 2)
        repeat(2) { service.execute("client") {} }
        var invoked = false

        val failure = assertThrows(SupportProgramRequestRejectedException::class.java) {
            service.execute("client") { invoked = true }
        }

        assertEquals(Reason.RATE_LIMITED, failure.reason)
        assertEquals(60, failure.retryAfterSeconds)
        assertEquals(false, invoked)
    }

    @Test
    fun tracksDifferentClientsIndependently() {
        val service = service(perClient = 1)
        service.execute("first") {}
        service.execute("second") {}

        assertEquals(Reason.RATE_LIMITED, rejected(service, "first").reason)
        assertEquals(Reason.RATE_LIMITED, rejected(service, "second").reason)
    }

    @Test
    fun globalLimitAlsoRejectsNewClientAddresses() {
        val service = service(global = 2)
        service.execute("first") {}
        service.execute("second") {}

        repeat(100) { assertEquals(Reason.RATE_LIMITED, rejected(service, "new-$it").reason) }
        now.set(60 * SECOND)
        service.execute("new-0") {}
        service.execute("new-1") {}
        assertEquals(Reason.RATE_LIMITED, rejected(service, "another").reason)
    }

    @Test
    fun roundsFractionalRetryAfterUpAndExpiresAtExactlySixtySeconds() {
        val service = service(perClient = 1)
        service.execute("client") {}
        now.set(SECOND / 2)
        assertEquals(60, rejected(service).retryAfterSeconds)
        now.set(59 * SECOND + 1)
        assertEquals(1, rejected(service).retryAfterSeconds)
        now.set(60 * SECOND - 1)
        assertEquals(1, rejected(service).retryAfterSeconds)

        now.set(60 * SECOND)
        assertEquals("allowed", service.execute("client") { "allowed" })
    }

    @Test
    fun usesARollingWindowInsteadOfResettingAllRequestsTogether() {
        val service = service(perClient = 2)
        service.execute("client") {}
        now.set(59 * SECOND)
        service.execute("client") {}
        now.set(60 * SECOND)
        service.execute("client") {}

        assertEquals(59, rejected(service).retryAfterSeconds)
        now.set(119 * SECOND)
        service.execute("client") {}
        assertEquals(1, rejected(service).retryAfterSeconds)
    }

    @Test
    fun waitsUntilBothClientAndGlobalLimitsHaveCapacity() {
        val service = service(perClient = 2, global = 3)
        service.execute("other") {}
        now.set(10 * SECOND)
        service.execute("client") {}
        now.set(20 * SECOND)
        service.execute("client") {}

        assertEquals(50, rejected(service).retryAfterSeconds)
        assertEquals(40, rejected(service, "new-client").retryAfterSeconds)
    }

    @Test
    fun rejectedRequestsDoNotExtendTheRateWindow() {
        val service = service(perClient = 1)
        service.execute("client") {}
        now.set(59 * SECOND)
        repeat(20) { rejected(service) }
        now.set(60 * SECOND)

        service.execute("client") {}
    }

    @Test
    fun releasesTheConcurrentSlotAfterAnExceptionButKeepsRateUsage() {
        val service = service(perClient = 1, concurrent = 1)
        val original = IllegalStateException("action failed")

        assertSame(original, assertThrows(IllegalStateException::class.java) {
            service.execute("client") { throw original }
        })
        assertEquals("released", service.execute("other") { "released" })
        assertEquals(Reason.RATE_LIMITED, rejected(service).reason)
    }

    @Test
    fun releasesTheConcurrentSlotAfterAnError() {
        val service = service(concurrent = 1)
        val original = AssertionError("action failed")

        assertSame(original, assertThrows(AssertionError::class.java) {
            service.execute("client") { throw original }
        })
        assertEquals("released", service.execute("client") { "released" })
    }

    @Test
    fun actionsRunOutsideTheLockAndBusyRequestsAreNotQueuedOrCharged() {
        val service = service(perClient = 1, concurrent = 2)
        val entered = CountDownLatch(2)
        val release = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(3)
        try {
            val holders = (1..2).map { index ->
                executor.submit<Unit> {
                    service.execute("holder-$index") {
                        entered.countDown()
                        assertTrue(release.await(5, TimeUnit.SECONDS))
                    }
                }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val rejection = executor.submit<SupportProgramRequestRejectedException> { rejected(service, "waiting") }

            val failure = rejection.get(1, TimeUnit.SECONDS)
            assertEquals(Reason.BUSY, failure.reason)
            assertEquals(1, failure.retryAfterSeconds)
            release.countDown()
            holders.forEach { it.get(5, TimeUnit.SECONDS) }
            service.execute("waiting") {}
        } finally {
            release.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun rateLimitTakesPrecedenceWhenRateAndConcurrentCapacityAreBothFull() {
        val service = service(perClient = 1, global = 1, concurrent = 1)
        service.execute("client") {
            val failure = rejected(service, "other")
            assertEquals(Reason.RATE_LIMITED, failure.reason)
            assertEquals(60, failure.retryAfterSeconds)
        }
    }

    @Test
    fun globalAdmissionIsAtomicAcrossSimultaneousClients() {
        assertAtomicLimit(service(global = 3, concurrent = 100)) { "client-$it" }
    }

    @Test
    fun clientAdmissionIsAtomicAcrossSimultaneousRequests() {
        assertAtomicLimit(service(perClient = 3, global = 100, concurrent = 100)) { "client" }
    }

    @Test
    fun expirationUsesElapsedMonotonicTimeEvenWhenNanoTimeWraps() {
        now.set(Long.MAX_VALUE - 30 * SECOND)
        val service = service(perClient = 1)
        service.execute("client") {}
        now.addAndGet(59 * SECOND)
        assertEquals(1, rejected(service).retryAfterSeconds)
        now.addAndGet(SECOND)

        service.execute("client") {}
    }

    private fun assertAtomicLimit(service: SupportProgramRequestAdmissionService, address: (Int) -> String) {
        val executor = Executors.newFixedThreadPool(20)
        val ready = CountDownLatch(20)
        val start = CountDownLatch(1)
        val accepted = AtomicInteger()
        val rejected = AtomicInteger()
        try {
            val attempts = (1..20).map { index ->
                executor.submit<Unit> {
                    ready.countDown()
                    assertTrue(start.await(5, TimeUnit.SECONDS))
                    try {
                        service.execute(address(index)) { accepted.incrementAndGet() }
                    } catch (failure: SupportProgramRequestRejectedException) {
                        assertEquals(Reason.RATE_LIMITED, failure.reason)
                        rejected.incrementAndGet()
                    }
                }
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS))
            start.countDown()
            attempts.forEach { it.get(5, TimeUnit.SECONDS) }
            assertEquals(3, accepted.get())
            assertEquals(17, rejected.get())
        } finally {
            start.countDown()
            executor.shutdownNow()
        }
    }

    private fun service(perClient: Int = 6, global: Int = 60, concurrent: Int = 4) =
        SupportProgramRequestAdmissionService(
            SupportProgramRequestAdmissionProperties(perClient, global, concurrent),
            now::get,
        )

    private fun rejected(service: SupportProgramRequestAdmissionService, address: String = "client") =
        assertThrows(SupportProgramRequestRejectedException::class.java) { service.execute(address) {} }

    private companion object {
        const val SECOND = 1_000_000_000L
    }
}
