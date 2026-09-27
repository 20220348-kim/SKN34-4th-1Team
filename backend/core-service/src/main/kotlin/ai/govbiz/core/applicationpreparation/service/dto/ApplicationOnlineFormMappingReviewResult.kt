package ai.govbiz.core.applicationpreparation.service.dto

import ai.govbiz.core.applicationpreparation.domain.ApplicationFieldMapping
import ai.govbiz.core.applicationpreparation.domain.ApplicationFieldMappingStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationOnlineFormReviewIssue

/** 읽기 전용 사용자 검토 결과. 개수는 문항 기준이며 검토 개수는 source 잔여 control을 포함한 issue 수다. */
data class ApplicationOnlineFormMappingReviewResult(
    val formId: String,
    val formTitle: String,
    val fieldMappings: List<ApplicationFieldMapping>,
    val issues: List<ApplicationOnlineFormReviewIssue>,
) {
    val mappedCount: Int get() = fieldMappings.count { it.mapped }
    val unmappedCount: Int get() = fieldMappings.size - mappedCount
    val reviewRequiredCount: Int get() = issues.size
    val requiredMissingCount: Int get() = fieldMappings.count { it.status == ApplicationFieldMappingStatus.REQUIRED_MAPPING_MISSING }
}
