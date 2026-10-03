package ai.govbiz.core.combinationreview.domain

import java.time.LocalDateTime

/**
 * 목록 조회용 검토 메타데이터. 개별 사업의 참여 사실은 상세 조회에서만 읽는다.
 * latestRun은 가장 최근에 접수한 실행의 요약이며, 목록에서 진행 · 완료 · 실패 상태를 보여 주는 데만 쓴다.
 */
data class CombinationReviewSummary(
    val id: Long,
    val title: String,
    val inputRevision: Long,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime,
    val latestRun: ReviewRunSummary? = null,
)
