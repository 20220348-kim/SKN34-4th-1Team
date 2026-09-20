package ai.govbiz.core.supportprogram.service.admission.config

import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.ApplicationContextRunner

class SupportProgramRequestAdmissionConfigTest {
    private val contextRunner = ApplicationContextRunner()
        .withUserConfiguration(SupportProgramRequestAdmissionConfig::class.java)

    @Test
    fun registersOneSharedServiceWithDefaultSettings() {
        contextRunner.run { context ->
            assertNull(context.startupFailure)
            assertEquals(1, context.getBeansOfType(SupportProgramRequestAdmissionService::class.java).size)
            assertEquals(60, context.getBean(SupportProgramRequestAdmissionProperties::class.java).globalPerMinute)
        }
    }

    @Test
    fun bindsConfiguredSettingsToTheService() {
        contextRunner.withPropertyValues(
            "app.support-program-request.per-client-per-minute=1",
            "app.support-program-request.global-per-minute=3",
            "app.support-program-request.max-concurrent=2",
        ).run { context ->
            assertNull(context.startupFailure)
            assertEquals(SupportProgramRequestAdmissionProperties(1, 3, 2), context.getBean(SupportProgramRequestAdmissionProperties::class.java))
            val service = context.getBean(SupportProgramRequestAdmissionService::class.java)
            service.execute("client") {}
            assertThrows(SupportProgramRequestRejectedException::class.java) { service.execute("client") {} }
        }
    }

    @Test
    fun refusesStartupWithInvalidSettings() {
        contextRunner.withPropertyValues("app.support-program-request.max-concurrent=0").run { context ->
            assertNotNull(context.startupFailure)
        }
    }
}
