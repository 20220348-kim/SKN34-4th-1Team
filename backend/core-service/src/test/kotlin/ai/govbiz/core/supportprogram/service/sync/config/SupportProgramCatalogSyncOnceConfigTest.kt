package ai.govbiz.core.supportprogram.service.sync.config

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.context.support.GenericApplicationContext
import org.springframework.core.env.MapPropertySource

class SupportProgramCatalogSyncOnceConfigTest {
    @Test
    fun isolatesBeforeBeanCreationEvenWhenCallerEnablesSchedulersAndFlyway() {
        GenericApplicationContext().use { context ->
            context.environment.setActiveProfiles("catalog-sync-once")
            val keys = listOf("app.bizinfo.sync.enabled", "app.kstartup.sync.enabled", "app.msit.sync.enabled",
                "app.cntrade-notice.sync.enabled", "app.support-program-index.enabled", "app.daily-report.queue.enabled",
                "app.combination-review.queue.enabled", "app.application-form-discovery.queue.enabled", "app.application-form-analysis.enabled", "spring.flyway.enabled")
            context.environment.propertySources.addFirst(MapPropertySource("caller",
                keys.associateWith { "true" } + ("spring.main.web-application-type" to "none")))
            SupportProgramCatalogSyncOnceConfig.isolate(context)
            keys.forEach { assertEquals("false", context.environment.getProperty(it)) }
        }
    }

    @Test
    fun normalApplicationIsUnchangedAndMixedOrWebProfilesAreRejected() {
        GenericApplicationContext().use { context ->
            SupportProgramCatalogSyncOnceConfig.isolate(context)
            assertFalse(context.environment.propertySources.contains("catalog-sync-once-isolation"))
            context.environment.setActiveProfiles("catalog-sync-once", "evaluation-capture")
            assertThrows(IllegalArgumentException::class.java) { SupportProgramCatalogSyncOnceConfig.isolate(context) }
            context.environment.setActiveProfiles("catalog-sync-once")
            assertThrows(IllegalArgumentException::class.java) { SupportProgramCatalogSyncOnceConfig.isolate(context) }
        }
    }
}
