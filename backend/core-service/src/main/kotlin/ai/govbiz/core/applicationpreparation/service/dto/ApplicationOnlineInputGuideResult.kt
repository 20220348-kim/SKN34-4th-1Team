package ai.govbiz.core.applicationpreparation.service.dto

import ai.govbiz.core.applicationpreparation.domain.*

data class ApplicationOnlineInputGuideResult(
    val preparationId: Long,
    val inputRevision: Long,
    val items: List<ApplicationOnlineInputGuideItemResult>,
    val savedAnswers: List<ApplicationSavedAnswerResult>,
    val officialApplicationUrl: String? = null,
    val externalMappingVerified: Boolean = false,
) {
    val totalCount get() = items.size
    val readyCount get() = items.count { it.status == ApplicationOnlineInputGuideStatus.READY }
    val needsReviewCount get() = items.count { it.status == ApplicationOnlineInputGuideStatus.NEEDS_REVIEW }
    val missingCount get() = items.count { it.status == ApplicationOnlineInputGuideStatus.MISSING }
    val directInputCount get() = items.count { it.status == ApplicationOnlineInputGuideStatus.DIRECT_INPUT }

    companion object {
        fun from(id: Long, revision: Long, manifest: ApplicationFormManifest, facts: List<ConfirmedApplicationFact>): ApplicationOnlineInputGuideResult {
            val byField = facts.associateBy { "${it.sectionKey}:${it.fieldKey}" }
            val saved = mutableListOf<ApplicationSavedAnswerResult>()
            val items = manifest.sections.flatMap { section -> section.fields.map { field ->
                val fieldId = "${section.key}:${field.key}"
                val answer = byField[fieldId]?.takeIf { it.status == ApplicationFactStatus.PROVIDED }?.value
                val valid = answer != null && (field.options.isEmpty() || answer in field.options)
                if (valid) saved += ApplicationSavedAnswerResult(fieldId, field.label, answer)
                ApplicationOnlineInputGuideItemResult(fieldId, null, field.label, field.required,
                    when {
                        answer == null -> ApplicationOnlineInputGuideStatus.MISSING
                        !valid -> ApplicationOnlineInputGuideStatus.NEEDS_REVIEW
                        else -> ApplicationOnlineInputGuideStatus.READY
                    }, answer, "UNKNOWN", field.options, valid)
            } }
            return ApplicationOnlineInputGuideResult(id, revision, items, saved)
        }

        fun fromSource(id: Long, revision: Long, manifest: ApplicationFormManifest, facts: List<ConfirmedApplicationFact>,
            source: ApplicationOnlineFormSource, officialUrl: String): ApplicationOnlineInputGuideResult {
            val review = manifest.reviewOnlineForm(source)
            val mapped = review.formMap.controls.associateBy { it.controlId }
            val issues = review.issues.flatMap { issue -> issue.candidateControlIds.map { it to issue.code } }.toMap()
            val byField = facts.associateBy { "${it.sectionKey}:${it.fieldKey}" }
            val saved = mutableListOf<ApplicationSavedAnswerResult>()
            val items = source.controls.map { control ->
                val fieldId = mapped[control.controlId]?.fieldId
                val answer = fieldId?.let { byField[it] }?.takeIf { it.status == ApplicationFactStatus.PROVIDED }?.value
                val status = when {
                    control.kind == ApplicationOnlineFormSourceKind.MULTI_CHOICE -> ApplicationOnlineInputGuideStatus.DIRECT_INPUT
                    fieldId == null && issues[control.controlId] != null && issues[control.controlId] != ApplicationOnlineFormReviewIssueCode.UNMATCHED_SOURCE_CONTROL -> ApplicationOnlineInputGuideStatus.NEEDS_REVIEW
                    fieldId == null -> ApplicationOnlineInputGuideStatus.DIRECT_INPUT
                    answer == null -> ApplicationOnlineInputGuideStatus.MISSING
                    control.kind in setOf(ApplicationOnlineFormSourceKind.SINGLE_CHOICE, ApplicationOnlineFormSourceKind.DROPDOWN) && answer !in control.options -> ApplicationOnlineInputGuideStatus.NEEDS_REVIEW
                    else -> ApplicationOnlineInputGuideStatus.READY
                }
                val copyable = status == ApplicationOnlineInputGuideStatus.READY
                if (copyable) saved += ApplicationSavedAnswerResult(requireNotNull(fieldId), control.label, requireNotNull(answer))
                ApplicationOnlineInputGuideItemResult(fieldId, control.controlId, control.label, control.required,
                    status, answer, control.kind.name, control.options, copyable)
            }
            return ApplicationOnlineInputGuideResult(id, revision, items, saved, officialUrl, review.issues.isEmpty())
        }
    }
}

enum class ApplicationOnlineInputGuideStatus { READY, NEEDS_REVIEW, MISSING, DIRECT_INPUT }
data class ApplicationOnlineInputGuideItemResult(
    val fieldId: String?, val sourceControlId: String?, val label: String, val required: Boolean,
    val status: ApplicationOnlineInputGuideStatus, val answer: String?, val inputMode: String,
    val options: List<String>, val copyable: Boolean,
)
data class ApplicationSavedAnswerResult(val fieldId: String, val label: String, val answer: String)
