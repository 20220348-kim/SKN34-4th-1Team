package ai.govbiz.core.supportprogram.service.sync.config

import ai.govbiz.core.supportprogram.service.sync.CnTradeNoticeSupportProgramCatalogSyncScheduler
import ai.govbiz.core.supportprogram.service.sync.CnTradeNoticeSupportProgramCatalogSyncService
import java.time.Duration
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.boot.test.context.runner.ApplicationContextRunner

class CnTradeNoticeSupportProgramCatalogSyncPropertiesTest {
    private val context = ApplicationContextRunner()
        .withBean(CnTradeNoticeSupportProgramCatalogSyncService::class.java, { mock(CnTradeNoticeSupportProgramCatalogSyncService::class.java) })
        .withUserConfiguration(CnTradeNoticeSupportProgramCatalogSyncScheduler::class.java)

    @Test
    fun isDisabledByDefaultAndDoesNotScheduleExternalCallsWithoutAnExplicitOptIn() {
        assertFalse(CnTradeNoticeSupportProgramCatalogSyncProperties().enabled)
        context.run { assertThat(it).doesNotHaveBean(CnTradeNoticeSupportProgramCatalogSyncScheduler::class.java) }
        context.withPropertyValues("app.cntrade-notice.sync.enabled=false")
            .run { assertThat(it).doesNotHaveBean(CnTradeNoticeSupportProgramCatalogSyncScheduler::class.java) }
    }

    @Test
    fun registersTheSchedulerOnlyWhenExplicitlyEnabled() {
        context.withPropertyValues("app.cntrade-notice.sync.enabled=true")
            .run { assertThat(it).hasSingleBean(CnTradeNoticeSupportProgramCatalogSyncScheduler::class.java) }
    }

    @Test
    fun rejectsNonpositiveIntervalsAndNegativeInitialDelays() {
        assertThrows(IllegalArgumentException::class.java) {
            CnTradeNoticeSupportProgramCatalogSyncProperties(initialDelay = Duration.ofSeconds(-1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            CnTradeNoticeSupportProgramCatalogSyncProperties(fixedDelay = Duration.ZERO)
        }
        CnTradeNoticeSupportProgramCatalogSyncProperties(initialDelay = Duration.ZERO)
    }
}
