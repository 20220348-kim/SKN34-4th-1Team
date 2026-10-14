package ai.govbiz.core.supportprogram.client.ops.dto

import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonInclude

data class ProductionQualityChunkRequest(
    val id: String,
    @get:JsonProperty("document_id") val documentId: String,
    val order: Int,
    val text: String,
)

data class ProductionQualityMaterialRequest(
    val question: String,
    val chunks: List<ProductionQualityChunkRequest>,
    val answer: String,
    @get:JsonProperty("answer_status") val answerStatus: String,
    @get:JsonProperty("citation_chunk_ids") val citationChunkIds: List<String>,
)

@JsonInclude(JsonInclude.Include.ALWAYS)
data class ProductionQualitySampleRequest(
    @get:JsonProperty("schema_version") val schemaVersion: Int = 1,
    val id: String,
    @get:JsonProperty("captured_at") val capturedAt: String,
    val scope: String = "support-program-evidence-answer",
    @get:JsonProperty("sample_rate_bps") val sampleRateBps: Int,
    @get:JsonProperty("source_document_id") val sourceDocumentId: String,
    @get:JsonProperty("trace_id") val traceId: String?,
    val release: String?,
    val material: ProductionQualityMaterialRequest,
    @get:JsonProperty("evidence_redacted") val evidenceRedacted: Boolean = false,
)

/** 기능별 운영 검토에 필요한 공개 자료만 담는 명시적 사본이다. */
data class ProductionQualityContextRequest(val id: String, val label: String, val text: String)

data class ProductionQualityOperationMaterialRequest(
    val question: String,
    val contexts: List<ProductionQualityContextRequest>,
    val output: String,
    @get:JsonProperty("output_status") val outputStatus: String,
    @get:JsonProperty("context_truncated") val contextTruncated: Boolean,
    @get:JsonProperty("output_truncated") val outputTruncated: Boolean,
)

@JsonInclude(JsonInclude.Include.ALWAYS)
data class ProductionQualityOperationSampleRequest(
    @get:JsonProperty("schema_version") val schemaVersion: Int = 2,
    val id: String,
    @get:JsonProperty("captured_at") val capturedAt: String,
    val scope: String,
    @get:JsonProperty("sample_rate_bps") val sampleRateBps: Int,
    @get:JsonProperty("source_document_id") val sourceDocumentId: String,
    @get:JsonProperty("trace_id") val traceId: String?,
    val release: String?,
    val material: ProductionQualityOperationMaterialRequest,
    @get:JsonProperty("evidence_redacted") val evidenceRedacted: Boolean,
)
