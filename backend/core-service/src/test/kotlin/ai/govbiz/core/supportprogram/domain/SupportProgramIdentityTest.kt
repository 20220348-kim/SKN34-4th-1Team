package ai.govbiz.core.supportprogram.domain

import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class SupportProgramIdentityTest {

    @Test
    fun createsAnUnambiguousProviderQualifiedIdEvenWhenTheRawIdContainsAColon() {
        val program = catalogProgram("PBLN:123").program.copy(sourceCode = "K_STARTUP")

        assertEquals("K_STARTUP:PBLN:123", program.sourceQualifiedId)
    }

    @Test
    fun acceptsA255CodePointRawIdEvenWhenItUsesSupplementaryCharacters() {
        val rawId = "🙂".repeat(255)

        val program = catalogProgram(rawId).program

        assertEquals("BIZINFO:$rawId", program.sourceQualifiedId)
    }

    @Test
    fun rejectsRawIdsThatCannotCrossTheIndexAndRankingContracts() {
        val invalidRawIds = listOf(
            "",
            "   ",
            " PBLN_123",
            "PBLN_123 ",
            "P".repeat(256),
            "PBLN\u0000_123",
            "PBLN\u200B_123",
        )

        invalidRawIds.forEach { rawId ->
            assertThrows(IllegalArgumentException::class.java) {
                catalogProgram(rawId)
            }
        }
    }

    @Test
    fun rejectsSourceCodesThatCannotBeSeparatedFromTheRawId() {
        assertThrows(IllegalArgumentException::class.java) {
            catalogProgram("PBLN_123").program.copy(sourceCode = "OTHER:SOURCE")
        }
    }
}
