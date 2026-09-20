package ai.govbiz.core.supportprogram.service.sync.config

import ai.govbiz.core.supportprogram.service.sync.KStartupSupportProgramCatalogSyncScheduler
import ai.govbiz.core.supportprogram.service.sync.KStartupSupportProgramCatalogSyncService
import java.time.Duration
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.boot.test.context.runner.ApplicationContextRunner

class KStartupSupportProgramCatalogSyncPropertiesTest {
    private val context = ApplicationContextRunner()
        .withBean(KStartupSupportProgramCatalogSyncService::class.java, { mock(KStartupSupportProgramCatalogSyncService::class.java) })
        .withUserConfiguration(KStartupSupportProgramCatalogSyncScheduler::class.java)

    @Test
    fun isDisabledByDefaultAndDoesNotScheduleExternalCallsWithoutAnExplicitOptIn() {
        assertFalse(KStartupSupportProgramCatalogSyncProperties().enabled)
        context.run { assertThat(it).doesNotHaveBean(KStartupSupportProgramCatalogSyncScheduler::class.java) }
        context.withPropertyValues("app.kstartup.sync.enabled=false")
            .run { assertThat(it).doesNotHaveBean(KStartupSupportProgramCatalogSyncScheduler::class.java) }
    }

    @Test
    fun registersTheSchedulerOnlyWhenExplicitlyEnabled() {
        context.withPropertyValues("app.kstartup.sync.enabled=true")
            .run { assertThat(it).hasSingleBean(KStartupSupportProgramCatalogSyncScheduler::class.java) }
    }

    @Test
    fun rejectsNonpositiveIntervalsAndNegativeInitialDelays() {
        assertThrows(IllegalArgumentException::class.java) {
            KStartupSupportProgramCatalogSyncProperties(initialDelay = Duration.ofSeconds(-1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            KStartupSupportProgramCatalogSyncProperties(fixedDelay = Duration.ZERO)
        }
        KStartupSupportProgramCatalogSyncProperties(initialDelay = Duration.ZERO)
    }
}
