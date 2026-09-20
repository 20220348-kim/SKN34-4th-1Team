package ai.govbiz.core.supportprogram.client.ai.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram
import com.fasterxml.jackson.annotation.JsonInclude

data class AiSupportProgramCandidateRequest(
    val id: String,
    val title: String,
    val organization: String,
    val summary: String,
    val categories: List<String>,
    val regions: List<String>,
    val targetDescription: String,
    val applicationPeriod: String,
    val status: String,
    val sourceTextTruncated: Boolean = false,
) {
    init {
        SupportProgram.requireCanonicalSourceQualifiedId(id)
    }
}

data class AiSupportProgramRankingRequest(
    val originalQuery: String,
    val scoringVersion: String,
    val resultLimit: Int,
    val candidates: List<AiSupportProgramCandidateRequest>,
    @field:JsonInclude(JsonInclude.Include.NON_NULL)
    val companyConditions: AiSupportProgramCompanyConditionsRequest? = null,
)

data class AiSupportProgramCompanyConditionsRequest(
    val region: String?,
    val industry: String?,
    val establishedOn: String?,
    val supportPurpose: String?,
    val referenceDate: String,
    @get:JsonInclude(JsonInclude.Include.NON_NULL)
    val foundedYear: Int? = null,
)
