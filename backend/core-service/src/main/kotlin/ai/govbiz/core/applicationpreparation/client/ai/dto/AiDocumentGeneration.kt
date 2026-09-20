package ai.govbiz.core.applicationpreparation.client.ai.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentTarget

data class AiDocumentConfigurationPayload(val contractVersion: String, val pipelineVersion: String)
data class AiDocumentGenerationRequest(
    val contractVersion: String = "application-document-mcp-v1",
    val sourceBase64: String,
    val sourceSha256: String,
    val format: String,
    val answerRevision: Long,
    val facts: List<ApplicationDocumentFact>,
    val scope: String,
    val pdfTargets: List<ApplicationDocumentTarget> = emptyList(),
    val pageImages: List<String> = emptyList(),
    val bindings: List<ApplicationDocumentPlacement> = emptyList(),
    val scopeTargetIds: List<String> = emptyList(),
    val pdfFields: List<Map<String, Any?>> = emptyList(),
    val hwpTargets: List<ApplicationDocumentTarget> = emptyList(),
)
data class AiDocumentGenerationPayload(
    val contractVersion: String,
    val pipelineVersion: String,
    val sourceSha256: String,
    val answerRevision: Long,
    val outputBase64: String,
    val outputSha256: String,
    val planHash: String,
    val mapVersion: String,
    val engineVersion: String,
    val verification: Map<String, Any?>,
    val placements: List<ApplicationDocumentPlacement>,
    val documentMap: Map<String, Any?>,
    val writePlan: Map<String, Any?>,
)

data class AiDocumentFieldReference(val id: String, val label: String, val guidance: String, val required: Boolean, val options: List<String>)
data class AiDocumentMappingRequest(
    val contractVersion: String = "application-document-mcp-v1",
    val sourceBase64: String,
    val sourceSha256: String,
    val format: String,
    val scope: String,
    val fields: List<AiDocumentFieldReference>,
    val pdfTargets: List<ApplicationDocumentTarget> = emptyList(),
    val pageImages: List<String> = emptyList(),
    val pdfFields: List<Map<String, Any?>> = emptyList(),
    val hwpTargets: List<ApplicationDocumentTarget> = emptyList(),
)
data class AiDocumentMappingPayload(
    val contractVersion: String,
    val pipelineVersion: String,
    val sourceSha256: String,
    val mapVersion: String,
    val engineVersion: String,
    val bindings: List<ApplicationDocumentPlacement>,
    val scopeTargetIds: List<String>,
    val documentMap: Map<String, Any?>,
)
