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
    @field:Pattern(regexp = MESSAGE)
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

/**
 * 사용자가 직접 쓴 메시지입니다. 다른 글자 필드와 달리 👩‍💻 속 결합 문자(ZWJ)나 웹에서 붙여 넣은 폭 없는 공백 같은 서식 문자(Cf),
 * 이 Java가 아직 모르는 새 이모지(Cn)는 받습니다. 제어·양방향 제어·대리 쌍·사용자 정의·비문자 코드 포인트와 보이는 글자가
 * 없는 메시지는 계속 거부합니다. 양방향 제어는 보이는 글과 저장된 글을 다르게 만들 수 있습니다(Trojan Source).
 */
private const val MESSAGE = "(?Us)^(?![\\s\\p{Cf}]*$)(?!.*[\\p{C}&&[^\\n\\r\\t\\p{Cf}\\p{Cn}]])" +
    "(?!.*[\\p{IsNoncharacter_Code_Point}\\x{061C}\\x{200E}\\x{200F}\\x{202A}-\\x{202E}\\x{2066}-\\x{2069}]).*$"

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
