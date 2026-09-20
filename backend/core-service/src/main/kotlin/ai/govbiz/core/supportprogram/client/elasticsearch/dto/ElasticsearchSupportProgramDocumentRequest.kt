package ai.govbiz.core.supportprogram.client.elasticsearch.dto

data class ElasticsearchSupportProgramDocumentRequest(
    val versionId: String,
    val id: String,
    val contentHash: String,
    val text: String,
    val sortTimestamp: String,
) {
    fun reference() = ElasticsearchSupportProgramReferenceRequest(versionId, id, contentHash, sortTimestamp)
}

data class ElasticsearchSupportProgramReferenceRequest(
    val versionId: String,
    val id: String,
    val contentHash: String,
    val sortTimestamp: String,
)
