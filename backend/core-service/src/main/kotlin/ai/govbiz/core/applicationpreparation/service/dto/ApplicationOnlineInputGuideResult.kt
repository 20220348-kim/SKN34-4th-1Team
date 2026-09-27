package ai.govbiz.core.applicationpreparation.service.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationFactStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ConfirmedApplicationFact

/** 외부 control mapping 여부와 별개로 현재 확정된 사용자 답변의 신청 준비 상태를 투영한다. */
data class ApplicationOnlineInputGuideResult(
    val preparationId: Long,
    val inputRevision: Long,
    val items: List<ApplicationOnlineInputGuideItemResult>,
    val savedAnswers: List<ApplicationSavedAnswerResult>,
) {
    val externalMappingVerified: Boolean get() = false
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
                if (valid) saved += ApplicationSavedAnswerResult(fieldId, field.label, answer!!)
                ApplicationOnlineInputGuideItemResult(fieldId, field.label, field.required,
                    when {
                        answer == null -> ApplicationOnlineInputGuideStatus.MISSING
                        !valid -> ApplicationOnlineInputGuideStatus.NEEDS_REVIEW
                        else -> ApplicationOnlineInputGuideStatus.READY
                    }, answer, "UNKNOWN", field.options, valid)
            } }
            return ApplicationOnlineInputGuideResult(id, revision, items, saved)
        }
    }
}

enum class ApplicationOnlineInputGuideStatus { READY, NEEDS_REVIEW, MISSING, DIRECT_INPUT }
data class ApplicationOnlineInputGuideItemResult(
    val fieldId: String, val label: String, val required: Boolean,
    val status: ApplicationOnlineInputGuideStatus, val answer: String?, val inputMode: String,
    val options: List<String>, val copyable: Boolean,
)
/** PROVIDED Fact의 텍스트 내보내기다. 외부 문항 타입/매핑 검토 완료를 뜻하지 않는다. */
data class ApplicationSavedAnswerResult(val fieldId: String, val label: String, val answer: String)
