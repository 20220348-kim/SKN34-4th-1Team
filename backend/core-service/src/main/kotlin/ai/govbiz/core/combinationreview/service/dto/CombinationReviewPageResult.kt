package ai.govbiz.core.combinationreview.service.dto

import ai.govbiz.core.combinationreview.domain.CombinationReviewSummary

data class CombinationReviewPageResult(
    val items: List<CombinationReviewSummary>,
    val nextBeforeId: Long?,
)
