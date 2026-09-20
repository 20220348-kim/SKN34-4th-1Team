package ai.govbiz.core.dailyreport.config

import ai.govbiz.core.dailyreport.service.DailyReportScheduler
import ai.govbiz.core.supportprogram.service.sync.config.SupportProgramIndexSyncConfig
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.core.io.ClassPathResource
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler
import java.util.Properties
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class DailyReportPropertiesTest {
    @Test
    fun defaultsDoNotSendEmailOrStartScheduling() {
        val properties = DailyReportProperties()
        assertFalse(properties.enabled)
        assertFalse(properties.mailEnabled)
        assertFalse(DailyReportQueueProperties().deliveryEnabled)
    }

    @Test
    fun springBindsExplicitEnablementAndBudgetSettings() {
        ApplicationContextRunner().withUserConfiguration(DailyReportConfig::class.java).withPropertyValues(
            "app.daily-report.enabled=true", "app.daily-report.mail-enabled=true",
            "app.daily-report.queue.enabled=true",
            "app.daily-report.queue.delivery-enabled=true",
            "app.daily-report.from=reports@example.org", "app.daily-report.frontend-base-url=https://govbiz.example",
            "app.daily-report.send-hour=9", "app.daily-report.max-reports-per-day=7",
        ).run { context ->
            assertNull(context.startupFailure)
            val properties = context.getBean(DailyReportProperties::class.java)
            assertTrue(properties.enabled)
            assertTrue(properties.mailEnabled)
            assertTrue(context.getBean(DailyReportQueueProperties::class.java).deliveryEnabled)
            assertEquals(9, properties.sendHour)
            assertEquals(7, properties.maxReportsPerDay)
            assertEquals("https://govbiz.example", properties.frontendBaseUrl)
        }
    }

    @Test
    fun evaluationProfilesExplicitlyDisableSchedulingAndMail() {
        listOf("evaluation-capture", "evaluation-fixture-export").forEach { profile ->
            val values = Properties()
            ClassPathResource("application-$profile.properties").inputStream.use(values::load)
            assertEquals("false", values.getProperty("app.daily-report.enabled"))
            assertEquals("false", values.getProperty("app.daily-report.queue.enabled"))
            assertEquals("false", values.getProperty("app.daily-report.queue.delivery-enabled"))
            assertEquals("false", values.getProperty("app.daily-report.mail-enabled"))
        }
    }

    @Test
    fun schedulerWithoutQueueFailsAtStartupInsteadOfPretendingToBeEnabled() {
        ApplicationContextRunner().withUserConfiguration(DailyReportConfig::class.java)
            .withPropertyValues("app.daily-report.enabled=true", "app.daily-report.queue.enabled=false")
            .run { context -> assertTrue(context.startupFailure != null) }
    }

    @Test
    fun disabledScheduledReportsDoNotCreateAReservationSchedulerEvenWithQueuesEnabled() {
        listOf(emptyArray<String>(), arrayOf("app.daily-report.enabled=false")).forEach { values ->
            ApplicationContextRunner().withUserConfiguration(DailyReportConfig::class.java)
                .withPropertyValues(*values, "app.daily-report.queue.enabled=true", "app.daily-report.queue.delivery-enabled=true")
                .run { context ->
                    assertNull(context.startupFailure)
                    assertFalse(context.containsBean("dailyReportTaskScheduler"))
                }
        }
    }

    @Test
    fun reservationUsesADedicatedSingleThreadWithTheExistingCadenceInBothDeliveryModes() {
        val scheduled = DailyReportScheduler::class.java.getMethod("run").getAnnotation(Scheduled::class.java)
        assertEquals("dailyReportTaskScheduler", scheduled.scheduler)
        assertEquals("PT1M", scheduled.initialDelayString)
        assertEquals("PT5M", scheduled.fixedDelayString)
        listOf(false, true).forEach { deliveryEnabled ->
            ApplicationContextRunner().withUserConfiguration(DailyReportConfig::class.java)
                .withPropertyValues("app.daily-report.enabled=true", "app.daily-report.queue.enabled=true",
                    "app.daily-report.queue.delivery-enabled=$deliveryEnabled")
                .run { context ->
                    assertNull(context.startupFailure)
                    val scheduler = context.getBean(scheduled.scheduler, ThreadPoolTaskScheduler::class.java)
                    assertEquals(1, scheduler.scheduledThreadPoolExecutor.corePoolSize)
                    assertEquals("daily-report-schedule-", scheduler.threadNamePrefix)
                }
        }
    }

    @Test
    fun blockedCatalogSchedulerDoesNotPreventTheReportSchedulerFromRunning() {
        ApplicationContextRunner().withUserConfiguration(DailyReportConfig::class.java, SupportProgramIndexSyncConfig::class.java)
            .withPropertyValues("app.daily-report.enabled=true", "app.daily-report.queue.enabled=true",
                "app.support-program-index.enabled=false", "app.support-program-index.initial-delay=PT15S",
                "app.support-program-index.fixed-delay=PT1M")
            .run { context ->
                assertNull(context.startupFailure)
                val catalog = context.getBean("taskScheduler", ThreadPoolTaskScheduler::class.java)
                val qualifier = DailyReportScheduler::class.java.getMethod("run").getAnnotation(Scheduled::class.java).scheduler
                val reports = context.getBean(qualifier, ThreadPoolTaskScheduler::class.java)
                assertNotSame(catalog, reports)
                val catalogStarted = CountDownLatch(1)
                val releaseCatalog = CountDownLatch(1)
                val catalogWork = catalog.submit {
                    catalogStarted.countDown()
                    check(releaseCatalog.await(10, TimeUnit.SECONDS)) { "test did not release catalog task" }
                }
                try {
                    assertTrue(catalogStarted.await(5, TimeUnit.SECONDS))
                    val reportWork = reports.submit<String> { Thread.currentThread().name }
                    assertTrue(reportWork.get(5, TimeUnit.SECONDS).startsWith("daily-report-schedule-"))
                    assertFalse(catalogWork.isDone, "report task must complete while catalog task is still blocked")
                } finally {
                    releaseCatalog.countDown()
                    catalogWork.get(5, TimeUnit.SECONDS)
                }
            }
    }

    @Test
    fun rejectsUnsafeLinksAndUnboundedCosts() {
        listOf("http://example.org", "https://user@example.org", "https://example.org?x=1", "https://example.org#token", "https://example.org/path").forEach {
            assertThrows(IllegalArgumentException::class.java) { DailyReportProperties(frontendBaseUrl = it) }
        }
        assertThrows(IllegalArgumentException::class.java) { DailyReportProperties(maxPrograms = 4) }
        assertThrows(IllegalArgumentException::class.java) { DailyReportProperties(maxReportsPerDay = 0) }
        assertThrows(IllegalArgumentException::class.java) { DailyReportProperties(maxAccountsPerRun = 101) }
        assertThrows(IllegalArgumentException::class.java) { DailyReportProperties(sendHour = 24) }
    }

    @Test
    fun enablingMailRequiresAnExplicitSingleSender() {
        assertThrows(IllegalArgumentException::class.java) { DailyReportProperties(mailEnabled = true) }
        assertThrows(IllegalArgumentException::class.java) {
            DailyReportProperties(mailEnabled = true, from = "reports@example.org\r\nBcc:other@example.org")
        }
        DailyReportProperties(mailEnabled = true, from = "reports@example.org", frontendBaseUrl = "https://app.example.org")
    }
}
