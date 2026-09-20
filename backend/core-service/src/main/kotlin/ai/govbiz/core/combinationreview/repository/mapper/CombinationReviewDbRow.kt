package ai.govbiz.core.combinationreview.repository.mapper

import java.time.LocalDateTime

/** combination_review 한 행을 위한 MyBatis 경계 타입. Repository 밖으로 노출하지 않는다. */
data class CombinationReviewDbRow(
    var id: Long = 0,
    var ownerAccountId: Long = 0,
    var title: String = "",
    var inputRevision: Long = 1,
    var createdAt: LocalDateTime? = null,
    var updatedAt: LocalDateTime? = null,
)
