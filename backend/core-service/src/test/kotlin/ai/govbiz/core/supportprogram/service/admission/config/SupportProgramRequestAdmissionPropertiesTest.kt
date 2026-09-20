package ai.govbiz.core.supportprogram.service.admission.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class SupportProgramRequestAdmissionPropertiesTest {
    @Test
    fun suppliesConservativeDefaults() {
        val properties = SupportProgramRequestAdmissionProperties()
        assertEquals(6, properties.perClientPerMinute)
        assertEquals(60, properties.globalPerMinute)
        assertEquals(4, properties.maxConcurrent)
    }

    @Test
    fun rejectsUnboundedOrNonPositiveClientLimits() {
        listOf(-1, 0, 10_001).forEach {
            assertThrows(IllegalArgumentException::class.java) {
                SupportProgramRequestAdmissionProperties(perClientPerMinute = it)
            }
        }
    }

    @Test
    fun rejectsUnboundedOrNonPositiveGlobalLimits() {
        listOf(-1, 0, 10_001).forEach {
            assertThrows(IllegalArgumentException::class.java) {
                SupportProgramRequestAdmissionProperties(globalPerMinute = it)
            }
        }
    }

    @Test
    fun rejectsUnboundedOrNonPositiveConcurrency() {
        listOf(-1, 0, 101).forEach {
            assertThrows(IllegalArgumentException::class.java) {
                SupportProgramRequestAdmissionProperties(maxConcurrent = it)
            }
        }
    }

    @Test
    fun acceptsBoundariesAndAllowsTheGlobalLimitToBeStricterThanTheClientLimit() {
        SupportProgramRequestAdmissionProperties(1, 1, 1)
        SupportProgramRequestAdmissionProperties(10_000, 10_000, 100)
        SupportProgramRequestAdmissionProperties(10, 5, 1)
    }
}
