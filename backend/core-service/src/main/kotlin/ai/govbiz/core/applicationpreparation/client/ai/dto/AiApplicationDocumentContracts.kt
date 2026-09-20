package ai.govbiz.core.applicationpreparation.client.ai.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentTarget
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement

data class AiApplicationDocumentRequest(
    val contractVersion: String = "application-document-v1",
    val facts: List<ApplicationDocumentFact>,
    val targets: List<ApplicationDocumentTarget>,
    val pageImages: List<String>,
)
data class AiApplicationDocumentPayload(
    val contractVersion: String,
    val placements: List<ApplicationDocumentPlacement>,
    val unmappedFactIds: List<String>,
    val clearExampleTargetIds: List<String> = emptyList(),
    val preserveExampleTargetIds: List<String> = emptyList(),
)
