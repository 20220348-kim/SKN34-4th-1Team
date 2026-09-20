package ai.govbiz.core.applicationpreparation.controller.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormSectionDefinition
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationPreparationDetailResult
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationPreparationListItemResult
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationPreparationPageResult
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormFieldDefinition
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryResult
import ai.govbiz.core.applicationpreparation.domain.ConfirmedApplicationFact
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationInterpretationResult
import java.time.OffsetDateTime
import java.time.ZoneId

data class ApplicationFormResponse(
    val formVersionId: String,
    val sourceCode: String,
    val sourceProgramId: String,
    val programTitle: String,
    val formTitle: String,
    val sourceUrl: String,
    val attachmentFileName: String,
    val attachmentSha256: String,
    val verificationStatus: String,
    val institutionReviewed: Boolean,
    val supportedServiceFields: List<String>,
    val sections: List<ApplicationFormSectionResponse>,
) {
    companion object {
        fun from(form: ApplicationFormManifest) = ApplicationFormResponse(
            form.formVersionId,
            form.sourceCode,
            form.sourceProgramId,
            form.programTitle,
            form.formTitle,
            form.sourceUrl,
            form.attachmentFileName,
            form.attachmentSha256,
            form.verificationStatus,
            form.institutionReviewed,
            form.supportedServiceFields.map { it.name },
            form.sections.map { ApplicationFormSectionResponse.from(it, unmapped = unmappedFields(form)) },
        )
        fun unmappedFields(form: ApplicationFormManifest): Set<String> =
            (form.documentMapSnapshot?.documentMap?.get("unmappedFieldIds") as? List<*>)?.filterIsInstance<String>()?.toSet().orEmpty()
    }
}

data class ApplicationFormSectionResponse(
    val key: String,
    val title: String,
    val locator: String,
    val description: String,
    val status: String = "NOT_STARTED",
    val fields: List<ApplicationFormFieldResponse>,
    val facts: List<ApplicationPreparationFactResponse> = emptyList(),
) {
    companion object {
        fun from(section: ApplicationFormSectionDefinition, facts: List<ConfirmedApplicationFact> = emptyList(), unmapped: Set<String> = emptySet()): ApplicationFormSectionResponse = ApplicationFormSectionResponse(
            section.key,
            section.title,
            section.locator,
            section.description,
            status = when {
                facts.isEmpty() -> "NOT_STARTED"
                section.fields.filter { it.required }.all { required -> facts.any { it.fieldKey == required.key } } -> "INPUT_CONFIRMED"
                else -> "IN_PROGRESS"
            },
            fields = section.fields.map { ApplicationFormFieldResponse.from(it, "${section.key}:${it.key}" !in unmapped) },
            facts = facts.map(ApplicationPreparationFactResponse::from),
        )
    }
}

data class ApplicationFormFieldResponse(val key: String, val label: String, val guidance: String, val required: Boolean, val options: List<String> = emptyList(), val documentWritable: Boolean = true) {
    companion object {
        fun from(field: ApplicationFormFieldDefinition, documentWritable: Boolean = true) = ApplicationFormFieldResponse(field.key, field.label, field.guidance, field.required, field.options, documentWritable)
    }
}

data class ApplicationPreparationFactResponse(
    val id: Long,
    val fieldKey: String,
    val status: String,
    val value: String?,
    val sourceText: String,
    val inputRevision: Long,
    val updatedAt: OffsetDateTime,
) {
    companion object {
        fun from(fact: ConfirmedApplicationFact) = ApplicationPreparationFactResponse(
            fact.id,
            fact.fieldKey,
            fact.status.name,
            fact.value,
            fact.sourceText,
            fact.inputRevision,
            fact.updatedAt.atZone(SEOUL).toOffsetDateTime(),
        )
    }
}

data class SupportedApplicationFormsResponse(val items: List<ApplicationFormResponse>) {
    companion object {
        fun from(forms: List<ApplicationFormManifest>) = SupportedApplicationFormsResponse(forms.map(ApplicationFormResponse::from))
    }
}

data class DiscoveredApplicationFormsResponse(
    val items: List<ApplicationFormResponse>,
    val warnings: List<String>,
    val cached: Boolean,
) {
    companion object {
        fun from(result: ApplicationFormDiscoveryResult) = DiscoveredApplicationFormsResponse(
            result.forms.map(ApplicationFormResponse::from), result.warnings, result.cached,
        )
    }
}

data class ApplicationPreparationResponse(
    val id: Long,
    val inputRevision: Long,
    val progressStage: String,
    val progressRevision: Long,
    val progressStageUpdatedAt: OffsetDateTime,
    val sourceCode: String,
    val sourceProgramId: String,
    val serviceField: String,
    val createdAt: OffsetDateTime,
    val updatedAt: OffsetDateTime,
    val form: ApplicationFormResponse,
    val contents: List<ApplicationContentVersionResponse>,
) {
    companion object {
        fun from(result: ApplicationPreparationDetailResult) = ApplicationPreparationResponse(
            id = result.preparation.id,
            inputRevision = result.preparation.inputRevision,
            progressStage = result.preparation.progressStage.name,
            progressRevision = result.preparation.progressRevision,
            progressStageUpdatedAt = result.preparation.progressStageUpdatedAt.atZone(SEOUL).toOffsetDateTime(),
            sourceCode = result.preparation.draft.sourceCode,
            sourceProgramId = result.preparation.draft.sourceProgramId,
            serviceField = result.preparation.draft.serviceField.name,
            createdAt = result.preparation.createdAt.atZone(SEOUL).toOffsetDateTime(),
            updatedAt = result.preparation.updatedAt.atZone(SEOUL).toOffsetDateTime(),
            form = ApplicationFormResponse.from(result.form).copy(
                sections = result.form.sections.map { section ->
                    ApplicationFormSectionResponse.from(section, result.facts.filter { it.sectionKey == section.key }, ApplicationFormResponse.unmappedFields(result.form))
                },
            ),
            result.contents.map { ApplicationContentVersionResponse.from(it, result.facts) },
        )
    }
}

data class ApplicationInterpretationResponse(
    val runId: Long,
    val inputRevision: Long,
    val sectionKey: String,
    val suggestions: List<ApplicationFactSuggestionResponse>,
    val missingFields: List<String>,
    val nextQuestion: String?,
) {
    companion object {
        fun from(result: ApplicationInterpretationResult) = ApplicationInterpretationResponse(
            result.runId,
            result.interpretation.inputRevision,
            result.interpretation.sectionKey,
            result.interpretation.suggestions.map {
                ApplicationFactSuggestionResponse(it.fieldKey, it.status.name, it.value, it.evidenceQuote)
            },
            result.interpretation.missingFields,
            result.interpretation.nextQuestion,
        )
    }
}

data class ApplicationFactSuggestionResponse(
    val fieldKey: String,
    val status: String,
    val value: String?,
    val evidenceQuote: String,
)

data class ApplicationPreparationSummaryResponse(
    val id: Long,
    val inputRevision: Long,
    val progressStage: String,
    val progressRevision: Long,
    val progressStageUpdatedAt: OffsetDateTime,
    val sourceCode: String,
    val sourceProgramId: String,
    val serviceField: String,
    val programTitle: String,
    val formTitle: String,
    val updatedAt: OffsetDateTime,
) {
    companion object {
        fun from(result: ApplicationPreparationListItemResult) = ApplicationPreparationSummaryResponse(
            id = result.preparation.id,
            inputRevision = result.preparation.inputRevision,
            progressStage = result.preparation.progressStage.name,
            progressRevision = result.preparation.progressRevision,
            progressStageUpdatedAt = result.preparation.progressStageUpdatedAt.atZone(SEOUL).toOffsetDateTime(),
            sourceCode = result.preparation.sourceCode,
            sourceProgramId = result.preparation.sourceProgramId,
            serviceField = result.preparation.serviceField.name,
            programTitle = result.form.programTitle,
            formTitle = result.form.formTitle,
            updatedAt = result.preparation.updatedAt.atZone(SEOUL).toOffsetDateTime(),
        )
    }
}

data class ApplicationPreparationPageResponse(
    val items: List<ApplicationPreparationSummaryResponse>,
    val nextBeforeId: Long?,
) {
    companion object {
        fun from(page: ApplicationPreparationPageResult) = ApplicationPreparationPageResponse(
            page.items.map(ApplicationPreparationSummaryResponse::from),
            page.nextBeforeId,
        )
    }
}

private val SEOUL = ZoneId.of("Asia/Seoul")

data class ApplicationContentVersionResponse(
    val id: Long,
    val sectionKey: String,
    val inputRevision: Long,
    val kind: String,
    val content: String,
    val stale: Boolean,
    val createdAt: OffsetDateTime,
    val confirmedAt: OffsetDateTime?,
) {
    companion object {
        fun from(version: ai.govbiz.core.applicationpreparation.domain.ApplicationContentVersion, facts: List<ConfirmedApplicationFact>) =
            ApplicationContentVersionResponse(version.id, version.sectionKey, version.inputRevision, version.kind, version.content,
                version.isStale(facts), version.createdAt.atZone(SEOUL).toOffsetDateTime(), version.confirmedAt?.atZone(SEOUL)?.toOffsetDateTime())
    }
}
