package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest

fun interface AiSupportProgramRankingClient {
    fun rankSupportPrograms(
        request: AiSupportProgramRankingRequest,
    ): AiSupportProgramRankingPayload
}
