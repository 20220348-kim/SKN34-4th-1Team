package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.controller.validation.CompanyFoundedYear
import ai.govbiz.core.supportprogram.controller.validation.CompanyEstablishedOn
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import com.fasterxml.jackson.annotation.JsonIgnore
import jakarta.validation.constraints.AssertTrue
import com.fasterxml.jackson.annotation.JsonSetter
import com.fasterxml.jackson.annotation.Nulls
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.time.LocalDate

data class SupportProgramSearchRequest(
    @field:NotBlank
    @field:Size(max = 500)
    @field:Pattern(regexp = "(?s)^(?!.*[\\p{C}&&[^\\n\\r\\t]]).*$")
    val query: String,
    @field:JsonSetter(nulls = Nulls.FAIL)
    val acceptingOnly: Boolean = true,
    @field:Valid
    val companyConditions: SupportProgramCompanyConditionsRequest? = null,
)

data class SupportProgramCompanyConditionsRequest(
    @field:Size(max = 50)
    @field:Pattern(regexp = "(?s)^(?!.*\\p{C}).*$")
    val region: String? = null,
    @field:Size(max = 100)
    @field:Pattern(regexp = "(?s)^(?!.*\\p{C}).*$")
    val industry: String? = null,
    @field:CompanyEstablishedOn
    @field:Size(max = 10)
    val establishedOn: String? = null,
    @field:Size(max = 100)
    @field:Pattern(regexp = "(?s)^(?!.*\\p{C}).*$")
    val supportPurpose: String? = null,
    @field:CompanyFoundedYear
    val foundedYear: Int? = null,
) {
    @get:AssertTrue
    @get:JsonIgnore
    val foundationPrecisionValid: Boolean
        get() = establishedOn.isNullOrBlank() || foundedYear == null

    fun toDomain(): SupportProgramCompanyConditions? {
        val conditions = SupportProgramCompanyConditions(
            region = region?.trim()?.takeIf(String::isNotEmpty),
            industry = industry?.trim()?.takeIf(String::isNotEmpty),
            establishedOn = establishedOn?.takeIf(String::isNotBlank)?.let(LocalDate::parse),
            supportPurpose = supportPurpose?.trim()?.takeIf(String::isNotEmpty),
            foundedYear = foundedYear,
        )
        return conditions.takeUnless {
            it.region == null && it.industry == null && it.establishedOn == null && it.supportPurpose == null && it.foundedYear == null
        }
    }
}
