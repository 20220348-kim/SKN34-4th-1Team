package ai.govbiz.core.supportprogram.client.ai.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram

data class AiSupportProgramIndexDocumentRequest(
    val id: String,
    val contentHash: String,
    val text: String,
) {
    init {
        SupportProgram.requireCanonicalSourceQualifiedId(id)
    }

    fun reference() = AiSupportProgramIndexReferenceRequest(id, contentHash)
}

data class AiSupportProgramIndexReferenceRequest(val id: String, val contentHash: String) {
    init {
        SupportProgram.requireCanonicalSourceQualifiedId(id)
    }
}

data class AiSupportProgramIndexBatchRequest(val documents: List<AiSupportProgramIndexDocumentRequest>)

data class AiSupportProgramIndexPruneRequest(
    val sourceCode: String,
    val documents: List<AiSupportProgramIndexReferenceRequest>,
)

data class AiSupportProgramIndexSearchRequest(
    val query: String,
    val eligibleDocuments: List<AiSupportProgramIndexReferenceRequest>,
    val limit: Int,
)
