package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.controller.validation.CompanyFoundedYear
import ai.govbiz.core.supportprogram.controller.validation.CompanyEstablishedOn
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationLastSearch
import ai.govbiz.core.supportprogram.domain.SupportProgramPendingClarification
import com.fasterxml.jackson.annotation.JsonIgnore
import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonSetter
import com.fasterxml.jackson.annotation.Nulls
import jakarta.validation.Valid
import jakarta.validation.constraints.AssertTrue
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.time.LocalDate

data class SupportProgramConversationRequest(
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 500)
    @field:Pattern(regexp = "(?Us)^(?!\\s*$)(?!.*[\\p{C}&&[^\\n\\r\\t]]).*$")
    val message: String,
    @param:JsonProperty(required = true)
    @field:Valid
    val context: SupportProgramConversationContextRequest,
    @field:Valid
    val pendingClarification: SupportProgramPendingClarificationRequest? = null,
    @field:Valid
    val pendingProposal: SupportProgramConversationContextRequest? = null,
    @field:Valid
    val lastSearch: SupportProgramConversationLastSearchRequest? = null,
) {
    @get:AssertTrue
    @get:JsonIgnore
    val pendingStateExclusive: Boolean
        get() = pendingClarification == null || pendingProposal == null
}

data class SupportProgramConversationContextRequest(
    @param:JsonProperty(required = true)
    @field:Size(max = 500)
    @field:Pattern(regexp = "(?Us)^(?!\\s*$)(?!.*[\\p{C}&&[^\\n\\r\\t]]).*$")
    val query: String?,
    @param:JsonProperty(required = true)
    @field:JsonSetter(nulls = Nulls.FAIL)
    val acceptingOnly: Boolean,
    @param:JsonProperty(required = true)
    @field:Valid
    val companyConditions: SupportProgramConversationCompanyConditionsRequest,
) {
    fun toDomain() = SupportProgramConversationContext(query, acceptingOnly, companyConditions.toDomain())
}

data class SupportProgramConversationCompanyConditionsRequest(
    @param:JsonProperty(required = true)
    @field:Size(max = 50)
    @field:Pattern(regexp = "(?Us)^(?!\\s*$)(?!.*\\p{C}).*$")
    val region: String?,
    @param:JsonProperty(required = true)
    @field:Size(max = 100)
    @field:Pattern(regexp = "(?Us)^(?!\\s*$)(?!.*\\p{C}).*$")
    val industry: String?,
    @param:JsonProperty(required = true)
    @field:Size(max = 10)
    @field:Pattern(regexp = "[0-9]{4}-[0-9]{2}-[0-9]{2}")
    @field:CompanyEstablishedOn
    val establishedOn: String?,
    @param:JsonProperty(required = true)
    @field:Size(max = 100)
    @field:Pattern(regexp = "(?Us)^(?!\\s*$)(?!.*\\p{C}).*$")
    val supportPurpose: String?,
    @field:CompanyFoundedYear
    val foundedYear: Int? = null,
) {
    @get:AssertTrue
    @get:JsonIgnore
    val foundationPrecisionValid: Boolean
        get() = establishedOn == null || foundedYear == null

    fun toDomain() = SupportProgramCompanyConditions(region, industry, establishedOn?.let(LocalDate::parse), supportPurpose, foundedYear)
}

data class SupportProgramPendingClarificationRequest(
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 160)
    @field:Pattern(regexp = "(?Us)^(?!\\s*$)(?!.*\\p{C}).*$")
    val question: String,
    @param:JsonProperty(required = true)
    @field:Valid
    val draftContext: SupportProgramConversationContextRequest,
) {
    fun toDomain() = SupportProgramPendingClarification(question, draftContext.toDomain())
}

data class SupportProgramConversationLastSearchRequest(
    @param:JsonProperty(required = true)
    @field:Valid
    val context: SupportProgramConversationContextRequest,
    @param:JsonProperty(required = true)
    @field:JsonSetter(nulls = Nulls.FAIL)
    @field:Min(0)
    val resultCount: Int,
) {
    fun toDomain() = SupportProgramConversationLastSearch(context.toDomain(), resultCount)
}
