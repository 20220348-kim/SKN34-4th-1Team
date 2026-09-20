package ai.govbiz.core.applicationpreparation.client.ai.dto

const val AI_APPLICATION_DRAFT_CONTRACT_VERSION = "application-preparation-draft-v1"

data class AiApplicationDraftRequest(
    val contractVersion: String = AI_APPLICATION_DRAFT_CONTRACT_VERSION,
    val preparationId: Long,
    val inputRevision: Long,
    val formVersionId: String,
    val sectionKey: String,
    val serviceField: String,
    val sectionTitle: String,
    val sectionDescription: String,
    val currentFacts: List<AiApplicationPreparationFactRequest>,
    val fieldOptions: List<AiApplicationPreparationFieldRequest>,
)

data class AiApplicationDraftPayload(
    val contractVersion: String,
    val preparationId: Long,
    val inputRevision: Long,
    val formVersionId: String,
    val sectionKey: String,
    val model: String,
    val promptVersion: String,
    val content: String,
    val usedFieldKeys: List<String>,
)
