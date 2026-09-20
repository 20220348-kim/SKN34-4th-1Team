package ai.govbiz.core.supportprogram.service.sync.config

import ai.govbiz.core.supportprogram.service.sync.MsitSupportProgramCatalogSyncScheduler
import ai.govbiz.core.supportprogram.service.sync.MsitSupportProgramCatalogSyncService
import java.time.Duration
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

class MsitSupportProgramCatalogSyncPropertiesTest {
    private val context = ApplicationContextRunner()
        .withBean(MsitSupportProgramCatalogSyncService::class.java, { mock(MsitSupportProgramCatalogSyncService::class.java) })
        .withUserConfiguration(MsitSupportProgramCatalogSyncScheduler::class.java)

    @Test
    fun isDisabledByDefaultAndDoesNotScheduleExternalCallsWithoutAnExplicitOptIn() {
        assertFalse(MsitSupportProgramCatalogSyncProperties().enabled)
        context.run { assertThat(it).doesNotHaveBean(MsitSupportProgramCatalogSyncScheduler::class.java) }
        context.withPropertyValues("app.msit.sync.enabled=false")
            .run { assertThat(it).doesNotHaveBean(MsitSupportProgramCatalogSyncScheduler::class.java) }
    }

    @Test
    fun registersTheSchedulerOnlyWhenExplicitlyEnabled() {
        context.withPropertyValues("app.msit.sync.enabled=true")
            .run { assertThat(it).hasSingleBean(MsitSupportProgramCatalogSyncScheduler::class.java) }
    }

    @Test
    fun assignsTheLongRunningCollectionToItsOwnOptInSingleThreadScheduler() {
        val scheduled = MsitSupportProgramCatalogSyncScheduler::class.java
            .getMethod("synchronize").getAnnotation(Scheduled::class.java)
        assertEquals("msitCatalogTaskScheduler", scheduled.scheduler)
        context.withUserConfiguration(MsitSupportProgramCatalogSyncConfig::class.java)
            .run { assertThat(it).doesNotHaveBean("msitCatalogTaskScheduler") }
        context.withUserConfiguration(MsitSupportProgramCatalogSyncConfig::class.java)
            .withPropertyValues("app.msit.sync.enabled=true", "app.msit.sync.initial-delay=1h")
            .run {
                val scheduler = it.getBean("msitCatalogTaskScheduler", ThreadPoolTaskScheduler::class.java)
                assertEquals(1, scheduler.poolSize)
                val thread = scheduler.submit(java.util.concurrent.Callable { Thread.currentThread().name }).get(5, TimeUnit.SECONDS)
                assertThat(thread).startsWith("msit-catalog-sync-")
            }
    }

    @Test
    fun rejectsNonpositiveIntervalsAndNegativeInitialDelays() {
        assertThrows(IllegalArgumentException::class.java) {
            MsitSupportProgramCatalogSyncProperties(initialDelay = Duration.ofSeconds(-1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            MsitSupportProgramCatalogSyncProperties(fixedDelay = Duration.ZERO)
        }
        MsitSupportProgramCatalogSyncProperties(initialDelay = Duration.ZERO)
    }
}
