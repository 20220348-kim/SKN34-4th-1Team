package ai.govbiz.core.notification.config

import ai.govbiz.core.notification.service.DeadlineReminderScheduler
import java.util.Properties
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.core.io.ClassPathResource
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

class DeadlineReminderPropertiesTest {
    @Test
    fun defaultsDoNotScheduleAndSendAfterNineInTheMorning() {
        val properties = DeadlineReminderProperties()
        assertFalse(properties.enabled)
        assertEquals(9, properties.sendHour)
        assertEquals(50, properties.maxPerRun)
        ApplicationContextRunner().withUserConfiguration(DeadlineReminderConfig::class.java).run { context ->
            assertNull(context.startupFailure)
            assertFalse(context.containsBean("deadlineReminderTaskScheduler"))
        }
    }

    @Test
    fun enabledReminderUsesItsOwnSingleThreadAndBindsTheSendHour() {
        val scheduled = DeadlineReminderScheduler::class.java.getMethod("run").getAnnotation(Scheduled::class.java)
        assertEquals("deadlineReminderTaskScheduler", scheduled.scheduler)
        ApplicationContextRunner().withUserConfiguration(DeadlineReminderConfig::class.java)
            .withPropertyValues("app.deadline-reminder.enabled=true", "app.deadline-reminder.send-hour=7",
                "app.deadline-reminder.max-per-run=20")
            .run { context ->
                assertNull(context.startupFailure)
                val properties = context.getBean(DeadlineReminderProperties::class.java)
                assertTrue(properties.enabled)
                assertEquals(7, properties.sendHour)
                assertEquals(20, properties.maxPerRun)
                val scheduler = context.getBean(scheduled.scheduler, ThreadPoolTaskScheduler::class.java)
                assertEquals(1, scheduler.scheduledThreadPoolExecutor.corePoolSize)
                assertEquals("deadline-reminder-", scheduler.threadNamePrefix)
            }
    }

    @Test
    fun rejectsInvalidHoursAndUnboundedBatches() {
        assertThrows(IllegalArgumentException::class.java) { DeadlineReminderProperties(sendHour = 24) }
        assertThrows(IllegalArgumentException::class.java) { DeadlineReminderProperties(maxPerRun = 0) }
        assertThrows(IllegalArgumentException::class.java) { DeadlineReminderProperties(maxPerRun = 501) }
    }

    @Test
    fun evaluationProfilesExplicitlyDisableTheReminderScheduler() {
        listOf("evaluation-capture", "evaluation-fixture-export").forEach { profile ->
            val values = Properties()
            ClassPathResource("application-$profile.properties").inputStream.use(values::load)
            assertEquals("false", values.getProperty("app.deadline-reminder.enabled"))
        }
    }
}
