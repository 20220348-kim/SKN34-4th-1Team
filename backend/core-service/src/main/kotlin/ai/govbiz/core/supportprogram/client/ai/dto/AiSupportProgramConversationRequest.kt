package ai.govbiz.core.supportprogram.client.ai.dto

data class AiSupportProgramConversationRequest(
    val schemaVersion: String,
    val referenceDate: String,
    val message: String,
    val context: AiSupportProgramConversationContextRequest,
    val pendingClarification: AiSupportProgramPendingClarificationRequest?,
    val pendingProposal: AiSupportProgramConversationContextRequest? = null,
    val lastSearch: AiSupportProgramConversationLastSearchRequest? = null,
)

data class AiSupportProgramConversationContextRequest(
    val query: String?,
    val acceptingOnly: Boolean,
    val companyConditions: AiSupportProgramConversationCompanyConditionsRequest,
)

data class AiSupportProgramConversationCompanyConditionsRequest(
    val region: String?,
    val industry: String?,
    val establishedOn: String?,
    val supportPurpose: String?,
    @get:com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    val foundedYear: Int? = null,
)

data class AiSupportProgramPendingClarificationRequest(
    val question: String,
    val draftContext: AiSupportProgramConversationContextRequest,
)

data class AiSupportProgramConversationLastSearchRequest(
    val context: AiSupportProgramConversationContextRequest,
    val resultCount: Int,
)
