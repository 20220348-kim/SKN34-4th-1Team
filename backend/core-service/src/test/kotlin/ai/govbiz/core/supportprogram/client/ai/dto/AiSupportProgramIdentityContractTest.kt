package ai.govbiz.core.supportprogram.client.ai.dto

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class AiSupportProgramIdentityContractTest {

    @Test
    fun preservesColonsInTheRawIdAcrossIndexAndRankingRequests() {
        val id = "BIZINFO:PBLN:123"

        assertEquals(id, document(id).id)
        assertEquals(id, document(id).reference().id)
        assertEquals(id, candidate(id).id)
    }

    @Test
    fun rejectsRawIdsThatViolateTheCanonicalIdentityRuleAcrossIndexAndRankingRequests() {
        val invalidIds = listOf(
            "BIZINFO:",
            "BIZINFO: PBLN_123",
            "BIZINFO:PBLN_123 ",
            "BIZINFO:${"P".repeat(256)}",
            "BIZINFO:PBLN\u0000_123",
            "BIZINFO:PBLN\u200B_123",
        )

        invalidIds.forEach { id ->
            assertThrows(IllegalArgumentException::class.java) { document(id) }
            assertThrows(IllegalArgumentException::class.java) {
                AiSupportProgramIndexReferenceRequest(id, "0".repeat(64))
            }
            assertThrows(IllegalArgumentException::class.java) { candidate(id) }
        }
    }

    private fun document(id: String) =
        AiSupportProgramIndexDocumentRequest(
            id = id,
            contentHash = "0".repeat(64),
            text = "서울 AI 기업 지원",
        )

    private fun candidate(id: String) =
        AiSupportProgramCandidateRequest(
            id = id,
            title = "서울 AI 기업 지원",
            organization = "기관",
            summary = "서울 AI 기업을 지원합니다.",
            categories = listOf("AI"),
            regions = listOf("서울"),
            targetDescription = "중소기업",
            applicationPeriod = "상시 접수",
            status = "OPEN",
        )
}
