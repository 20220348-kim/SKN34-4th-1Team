package ai.govbiz.core.applicationpreparation.domain

import java.time.LocalDateTime

enum class ApplicationFactStatus { PROVIDED, UNKNOWN }

data class ConfirmedApplicationFact(
    val id: Long,
    val sectionKey: String,
    val fieldKey: String,
    val status: ApplicationFactStatus,
    val value: String?,
    val sourceText: String,
    val inputRevision: Long,
    val updatedAt: LocalDateTime,
) {
    init {
        require(id > 0 && inputRevision > 0)
        validateApplicationFact(sectionKey, fieldKey, status, value, sourceText)
    }
}

data class NewConfirmedApplicationFact(
    val fieldKey: String,
    val status: ApplicationFactStatus,
    val value: String?,
    val sourceText: String,
) {
    init {
        validateApplicationFact("valid-section", fieldKey, status, value, sourceText)
    }
}

data class ApplicationFactSuggestion(
    val fieldKey: String,
    val status: ApplicationFactStatus,
    val value: String?,
    val evidenceQuote: String,
)

data class ApplicationInterpretationConfiguration(
    val contractVersion: String,
    val model: String,
    val promptVersion: String,
)

data class ApplicationInterpretation(
    val preparationId: Long,
    val inputRevision: Long,
    val formVersionId: String,
    val sectionKey: String,
    val suggestions: List<ApplicationFactSuggestion>,
    val missingFields: List<String>,
    val nextQuestion: String?,
    val configuration: ApplicationInterpretationConfiguration,
)

data class ApplicationInterpretationInputSnapshot(
    val inputRevision: Long,
    val formVersionId: String,
    val sectionKey: String,
    val serviceField: ApplicationServiceField,
    val userMessage: String,
    val currentFacts: List<ConfirmedApplicationFact>,
)

enum class ApplicationInterpretationRunStatus { RUNNING, SUCCEEDED, FAILED }

data class StoredApplicationInterpretationRun(
    val id: Long,
    val preparationId: Long,
    val inputRevision: Long,
    val requestKey: String,
    val requestHash: String,
    val status: ApplicationInterpretationRunStatus,
    val input: ApplicationInterpretationInputSnapshot,
    val output: ApplicationInterpretation?,
    val failureCode: String?,
    val startedAt: LocalDateTime,
    val finishedAt: LocalDateTime?,
)

data class ApplicationInterpretationReservation(val run: StoredApplicationInterpretationRun, val created: Boolean)

sealed interface ApplicationInputReplaceResult {
    data object NotFound : ApplicationInputReplaceResult
    data object RevisionConflict : ApplicationInputReplaceResult
    data class Updated(val inputRevision: Long) : ApplicationInputReplaceResult
}

private fun validateApplicationFact(
    sectionKey: String,
    fieldKey: String,
    status: ApplicationFactStatus,
    value: String?,
    sourceText: String,
) {
    val keyPattern = Regex("[a-z][a-z0-9-]{0,63}")
    require(keyPattern.matches(sectionKey) && keyPattern.matches(fieldKey))
    require(sourceText.isNotBlank() && sourceText == sourceText.trim() && sourceText.codePointCount(0, sourceText.length) <= 4000)
    when (status) {
        ApplicationFactStatus.PROVIDED -> require(
            value != null && value.isNotBlank() && value == value.trim() && value.codePointCount(0, value.length) <= 2000,
        )
        ApplicationFactStatus.UNKNOWN -> require(value == null)
    }
}
