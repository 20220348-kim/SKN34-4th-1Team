package ai.govbiz.core.supportprogram.service.projection

import ai.govbiz.core.supportprogram.client.catalog.CatalogSnapshotClient
import ai.govbiz.core.supportprogram.client.catalog.config.CatalogClientProperties
import ai.govbiz.core.supportprogram.client.catalog.exception.CatalogServiceCallException
import ai.govbiz.core.supportprogram.domain.CatalogProjectionSnapshot
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncOutcome
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.core.supportprogram.repository.CatalogProjectionRepository
import ai.govbiz.core.supportprogram.service.projection.config.CatalogOwnershipGuard
import ai.govbiz.core.supportprogram.service.sync.*
import ai.govbiz.core.supportprogram.service.sync.config.SupportProgramCatalogSyncOnceConfig
import java.net.URI
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.context.support.GenericApplicationContext
import org.springframework.core.env.MapPropertySource
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.TransactionStatus

class CatalogProjectionOwnershipTest {
    @Test
    fun remoteModeDoesNotAssembleAnyLegacySourceOrIndexWriterEvenIfTheirFlagsAreTrue() {
        ApplicationContextRunner().withUserConfiguration(
            BizInfoSupportProgramCatalogSyncService::class.java, KStartupSupportProgramCatalogSyncService::class.java,
            MsitSupportProgramCatalogSyncService::class.java, CnTradeNoticeSupportProgramCatalogSyncService::class.java,
            BizInfoSupportProgramCatalogSyncScheduler::class.java, KStartupSupportProgramCatalogSyncScheduler::class.java,
            MsitSupportProgramCatalogSyncScheduler::class.java, CnTradeNoticeSupportProgramCatalogSyncScheduler::class.java,
            SupportProgramIndexSyncService::class.java, SupportProgramIndexSyncScheduler::class.java,
            SupportProgramCatalogPublicationService::class.java,
        ).withPropertyValues("app.catalog.projection.enabled=true", "app.bizinfo.sync.enabled=true",
            "app.kstartup.sync.enabled=true", "app.msit.sync.enabled=true", "app.cntrade-notice.sync.enabled=true",
            "app.support-program-index.enabled=true").run { context ->
                assertNull(context.startupFailure)
                assertTrue(context.getBeansOfType(BizInfoSupportProgramCatalogSyncScheduler::class.java).isEmpty())
                assertTrue(context.getBeansOfType(SupportProgramIndexSyncService::class.java).isEmpty())
                assertTrue(context.getBeansOfType(SupportProgramCatalogPublicationService::class.java).isEmpty())
            }
    }

    @Test
    fun refusesImplicitReturnToEmbeddedOwnershipAfterReceivingRemoteData() {
        val repository = mock(CatalogProjectionRepository::class.java)
        `when`(repository.hasCheckpoints()).thenReturn(true)
        assertThrows(IllegalStateException::class.java) { CatalogOwnershipGuard(repository, false).afterSingletonsInstantiated() }
        assertDoesNotThrow { CatalogOwnershipGuard(repository, true).afterSingletonsInstantiated() }
        `when`(repository.hasCheckpoints()).thenReturn(false)
        assertDoesNotThrow { CatalogOwnershipGuard(repository, false).afterSingletonsInstantiated() }
    }

    @Test
    fun oneShotCoreCollectionIsRejectedInRemoteMode() {
        GenericApplicationContext().use { context ->
            context.environment.setActiveProfiles("catalog-sync-once")
            context.environment.propertySources.addFirst(MapPropertySource("test", mapOf(
                "spring.main.web-application-type" to "none", "app.catalog.projection.enabled" to "true")))
            assertThrows(IllegalArgumentException::class.java) { SupportProgramCatalogSyncOnceConfig.isolate(context) }
        }
    }

    @Test
    fun networkFailureNeverStartsProjectionWrites() {
        val client = mock(CatalogSnapshotClient::class.java)
        val repository = mock(CatalogProjectionRepository::class.java)
        val transactions = mock(PlatformTransactionManager::class.java)
        `when`(client.fetch("BIZINFO")).thenThrow(CatalogServiceCallException(CatalogServiceCallException.Failure.UNAVAILABLE))
        assertThrows(CatalogServiceCallException::class.java) { CatalogProjectionService(client, repository, transactions).synchronize("BIZINFO") }
        verifyNoInteractions(repository, transactions)
    }

    @Test
    fun serviceStartsAndCommitsTheTransactionOnlyAfterHttpCollectionCompletes() {
        val client = mock(CatalogSnapshotClient::class.java)
        val repository = mock(CatalogProjectionRepository::class.java)
        val transactions = mock(PlatformTransactionManager::class.java)
        val transactionStatus = mock(TransactionStatus::class.java)
        val snapshot = snapshot()
        `when`(client.fetch("BIZINFO")).thenReturn(snapshot)
        `when`(transactions.getTransaction(any(TransactionDefinition::class.java))).thenReturn(transactionStatus)
        `when`(repository.apply(snapshot)).thenReturn(true)

        assertTrue(CatalogProjectionService(client, repository, transactions).synchronize("BIZINFO"))

        val order = inOrder(client, transactions, repository)
        order.verify(client).fetch("BIZINFO")
        order.verify(transactions).getTransaction(any(TransactionDefinition::class.java))
        order.verify(repository).apply(snapshot)
        order.verify(transactions).commit(transactionStatus)
        order.verifyNoMoreInteractions()
    }

    @Test
    fun serviceRollsBackWhenAtomicProjectionFails() {
        val client = mock(CatalogSnapshotClient::class.java)
        val repository = mock(CatalogProjectionRepository::class.java)
        val transactions = mock(PlatformTransactionManager::class.java)
        val transactionStatus = mock(TransactionStatus::class.java)
        val snapshot = snapshot()
        `when`(client.fetch("BIZINFO")).thenReturn(snapshot)
        `when`(transactions.getTransaction(any(TransactionDefinition::class.java))).thenReturn(transactionStatus)
        `when`(repository.apply(snapshot)).thenThrow(IllegalStateException("projection rejected"))

        assertThrows(IllegalStateException::class.java) {
            CatalogProjectionService(client, repository, transactions).synchronize("BIZINFO")
        }

        verify(transactions).rollback(transactionStatus)
        verify(transactions, never()).commit(transactionStatus)
    }

    @Test
    fun oneSourceFailureDoesNotPreventOtherSourcesFromSynchronizing() {
        val service = mock(CatalogProjectionService::class.java)
        `when`(service.synchronize("BIZINFO")).thenThrow(CatalogServiceCallException(CatalogServiceCallException.Failure.UNAVAILABLE))
        val properties = CatalogClientProperties(URI("http://catalog.test"), "fixture-only-012345678901234567890123", sources = listOf("BIZINFO", "MSIT"))
        CatalogProjectionScheduler(service, properties).synchronize()
        verify(service).synchronize("BIZINFO")
        verify(service).synchronize("MSIT")
    }

    private fun snapshot() = CatalogProjectionSnapshot(
        "30a5d246-39ca-40ed-a6ac-9354315111e0", 1,
        SupportProgramSyncStatus("BIZINFO", 1, SupportProgramCatalogFingerprintHelper.calculate(emptyList()), 0,
            true, null, null, SupportProgramSyncOutcome.SUCCESS),
        emptyList(),
    )
}
