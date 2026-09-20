package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.controller.validation.CodePointMax
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

data class SupportProgramEvidenceQuestionRequest(
    @field:NotBlank
    @field:Size(max = 64)
    @field:Pattern(regexp = "[A-Z][A-Z0-9_]{0,63}")
    val sourceCode: String,
    @field:NotBlank
    @field:CodePointMax(max = 255)
    @field:Pattern(regexp = "(?Us)^(?!\\s)(?!.*\\s$)(?!.*\\p{C}).+$")
    val sourceProgramId: String,
    @field:NotBlank
    @field:Size(max = 500)
    @field:Pattern(regexp = "(?s)^(?!.*[\\p{C}&&[^\\n\\r\\t]]).+$")
    val question: String,
)
