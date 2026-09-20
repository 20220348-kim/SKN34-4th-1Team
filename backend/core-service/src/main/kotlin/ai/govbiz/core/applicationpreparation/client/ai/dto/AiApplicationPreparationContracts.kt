package ai.govbiz.core.applicationpreparation.client.ai.dto

const val AI_APPLICATION_PREPARATION_CONTRACT_VERSION = "application-preparation-interpret-v1"
const val AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION = "application-form-discovery-v1"

data class AiApplicationPreparationConfigurationPayload(
    val contractVersion: String,
    val model: String,
    val promptVersion: String,
    val modelTimeoutSeconds: Double? = null,
    val runTimeoutSeconds: Double? = null,
)

data class AiApplicationPreparationInterpretRequest(
    val contractVersion: String,
    val preparationId: Long,
    val inputRevision: Long,
    val formVersionId: String,
    val sectionKey: String,
    val serviceField: String,
    val userMessage: String,
    val currentFacts: List<AiApplicationPreparationFactRequest>,
    val fieldOptions: List<AiApplicationPreparationFieldRequest>,
)

data class AiApplicationPreparationFactRequest(val fieldKey: String, val status: String, val value: String?)
data class AiApplicationPreparationFieldRequest(val fieldKey: String, val label: String, val guidance: String, val required: Boolean)

data class AiApplicationPreparationInterpretPayload(
    val contractVersion: String,
    val model: String,
    val promptVersion: String,
    val preparationId: Long,
    val inputRevision: Long,
    val formVersionId: String,
    val sectionKey: String,
    val suggestions: List<AiApplicationPreparationSuggestionPayload>,
    val missingFields: List<String>,
    val nextQuestion: String?,
)

data class AiApplicationPreparationSuggestionPayload(
    val fieldKey: String,
    val status: String,
    val value: String?,
    val evidenceQuote: String,
)

data class AiApplicationFormDiscoveryRequest(
    val contractVersion: String,
    val sourceCode: String,
    val sourceProgramId: String,
    val programTitle: String,
    val documents: List<AiApplicationFormDiscoveryDocumentRequest>,
)

data class AiApplicationFormDiscoveryDocumentRequest(
    val documentIndex: Int,
    val fileName: String,
    val format: String,
    val blocks: List<AiApplicationFormDiscoveryBlockRequest>,
    @get:com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    val sourceBase64: String? = null,
    @get:com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    val sourceSha256: String? = null,
)

data class AiApplicationFormDiscoveryBlockRequest(val blockId: String, val locator: String, val text: String)

data class AiApplicationFormDiscoveryPayload(
    val contractVersion: String,
    val model: String,
    val promptVersion: String,
    val forms: List<AiDiscoveredApplicationFormPayload>,
)

data class AiDiscoveredApplicationFormPayload(
    val documentIndex: Int,
    val sections: List<AiDiscoveredApplicationFormSectionPayload>,
)

data class AiDiscoveredApplicationFormSectionPayload(
    val sectionKey: String,
    val title: String,
    val description: String,
    val fields: List<AiDiscoveredApplicationFormFieldPayload>,
)

data class AiDiscoveredApplicationFormFieldPayload(
    val fieldKey: String,
    val label: String,
    val guidance: String,
    val required: Boolean,
    val evidenceBlockId: String,
    val evidenceQuote: String,
    val options: List<String> = emptyList(),
)
