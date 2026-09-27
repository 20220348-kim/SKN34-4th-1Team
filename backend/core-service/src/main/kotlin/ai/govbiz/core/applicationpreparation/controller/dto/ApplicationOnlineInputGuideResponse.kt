package ai.govbiz.core.applicationpreparation.controller.dto

import ai.govbiz.core.applicationpreparation.service.dto.ApplicationOnlineInputGuideResult

data class ApplicationOnlineInputGuideResponse(
    val preparationId: Long, val inputRevision: Long,
    val totalCount: Int, val readyCount: Int, val needsReviewCount: Int,
    val missingCount: Int, val directInputCount: Int,
    val officialApplicationUrl: String?,
    val externalMappingVerified: Boolean,
    val items: List<ApplicationOnlineInputGuideItemResponse>,
    val savedAnswers: List<ApplicationSavedAnswerResponse>,
) {
    companion object {
        fun from(result: ApplicationOnlineInputGuideResult) = ApplicationOnlineInputGuideResponse(
            result.preparationId, result.inputRevision, result.totalCount, result.readyCount,
            result.needsReviewCount, result.missingCount, result.directInputCount,
            // 현재 모델의 sourceUrl은 공고 원문이며 신청 URL이 아니다.
            null, result.externalMappingVerified,
            result.items.map { ApplicationOnlineInputGuideItemResponse(it.fieldId, it.label, it.required,
                it.status.name, it.answer, it.inputMode, it.options, it.copyable) },
            result.savedAnswers.map { ApplicationSavedAnswerResponse(it.fieldId, it.label, it.answer) },
        )
    }
}
data class ApplicationOnlineInputGuideItemResponse(
    val fieldId: String, val label: String, val required: Boolean, val status: String,
    val answer: String?, val inputMode: String, val options: List<String>, val copyable: Boolean,
)
data class ApplicationSavedAnswerResponse(val fieldId: String, val label: String, val answer: String)
