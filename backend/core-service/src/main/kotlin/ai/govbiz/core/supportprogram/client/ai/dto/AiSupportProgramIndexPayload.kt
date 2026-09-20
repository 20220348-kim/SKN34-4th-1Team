package ai.govbiz.core.supportprogram.client.ai.dto

data class AiSupportProgramIndexBatchPayload(val indexedCount: Int?)

data class AiSupportProgramIndexPrunePayload(val retainedCount: Int?)

data class AiSupportProgramIndexSearchPayload(
    val query: String?,
    val matches: List<AiSupportProgramIndexMatchPayload?>?,
)

data class AiSupportProgramIndexMatchPayload(
    val id: String?,
    val contentHash: String?,
    val score: Double?,
)
