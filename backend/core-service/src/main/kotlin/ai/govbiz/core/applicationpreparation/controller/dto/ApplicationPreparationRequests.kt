package ai.govbiz.core.applicationpreparation.controller.dto

import ai.govbiz.core.applicationpreparation.controller.exception.InvalidApplicationPreparationInputException
import ai.govbiz.core.applicationpreparation.domain.ApplicationServiceField
import ai.govbiz.core.applicationpreparation.domain.ApplicationProgressStage
import ai.govbiz.core.applicationpreparation.domain.NewApplicationPreparation
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotNull
import jakarta.validation.Valid

data class DiscoverApplicationFormsRequest(
    @field:NotBlank @field:Pattern(regexp = "BIZINFO|KSTARTUP|MSIT|CNTRADE_NOTICE") val sourceCode: String,
    @field:NotBlank @field:Size(max = 255) val sourceProgramId: String,
)

data class CreateApplicationPreparationRequest(
    @field:NotBlank @field:Size(max = 64) val sourceCode: String,
    @field:NotBlank @field:Size(max = 255) val sourceProgramId: String,
    @field:NotBlank @field:Pattern(regexp = "[a-z0-9][a-z0-9-]{0,159}") val formVersionId: String,
    @field:NotBlank val serviceField: String,
) {
    fun toDraft(): NewApplicationPreparation = try {
        NewApplicationPreparation(
            sourceCode = sourceCode,
            sourceProgramId = sourceProgramId,
            formVersionId = formVersionId,
            serviceField = ApplicationServiceField.valueOf(serviceField),
        )
    } catch (_: IllegalArgumentException) {
        throw InvalidApplicationPreparationInputException()
    }
}

data class InterpretApplicationPreparationRequest(
    @field:Min(1) val expectedRevision: Long,
    @field:NotBlank @field:Pattern(regexp = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    val requestKey: String,
    @field:NotBlank @field:Size(max = 4000) val message: String,
)

data class ReplaceApplicationPreparationInputsRequest(
    @field:Min(1) val expectedRevision: Long,
    @field:NotNull @field:Size(max = 20) @field:Valid val facts: List<ApplicationPreparationFactRequest>,
) {
    fun toFacts(): List<ai.govbiz.core.applicationpreparation.domain.NewConfirmedApplicationFact> = try {
        facts.map { fact ->
            ai.govbiz.core.applicationpreparation.domain.NewConfirmedApplicationFact(
                fact.fieldKey,
                ai.govbiz.core.applicationpreparation.domain.ApplicationFactStatus.valueOf(fact.status),
                fact.value?.trim(),
                fact.sourceText.trim(),
            )
        }
    } catch (_: IllegalArgumentException) {
        throw InvalidApplicationPreparationInputException()
    }
}

data class ApplicationPreparationFactRequest(
    @field:NotBlank @field:Pattern(regexp = "[a-z][a-z0-9-]{0,63}") val fieldKey: String,
    @field:NotBlank @field:Pattern(regexp = "PROVIDED|UNKNOWN") val status: String,
    @field:Size(max = 2000) val value: String?,
    @field:NotBlank @field:Size(max = 4000) val sourceText: String,
)

data class GenerateApplicationDraftRequest(
    @field:Min(1) val expectedRevision: Long,
    @field:Min(1) val expectedVersionId: Long?,
    @field:NotBlank @field:Pattern(regexp = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}") val requestKey: String,
)

data class SaveApplicationContentRequest(
    @field:Min(1) val expectedRevision: Long,
    @field:Min(1) val expectedVersionId: Long,
    @field:NotBlank @field:Size(max = 15000) val content: String,
)

data class ConfirmApplicationContentRequest(
    @field:Min(1) val expectedRevision: Long,
    @field:Min(1) val expectedVersionId: Long,
)
data class UpdateApplicationProgressRequest(
    @field:Min(1) val expectedProgressRevision: Long,
    @field:NotBlank val progressStage: String,
) {
    fun toProgressStage(): ApplicationProgressStage = try {
        ApplicationProgressStage.valueOf(progressStage)
    } catch (_: IllegalArgumentException) {
        throw InvalidApplicationPreparationInputException()
    }
}
