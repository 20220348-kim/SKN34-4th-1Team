package ai.govbiz.core.combinationreview.domain

import java.time.LocalDateTime

/** 저장 전에 검증한 검토 제목과 현재 입력. 공식 근거 검수·지원 자격 판단은 포함하지 않는다. */
data class CombinationReviewDraft(
    val title: String,
    val input: CombinationReviewInput,
) {
    init {
        require(title.isNotBlank() && title == title.trim()) { "review title must be trimmed and nonblank" }
        require(title.codePointCount(0, title.length) <= 200 && !Regex("\\p{C}").containsMatchIn(title)) {
            "review title must be at most 200 code points without Unicode other characters"
        }
    }
}

/** 저장된 검토 건의 현재 입력. 분석 실행 이력(Run)은 별도 후속 기능이다. 시각은 서울 기준이다. */
data class StoredCombinationReview(
    val id: Long,
    val ownerAccountId: Long,
    val inputRevision: Long,
    val draft: CombinationReviewDraft,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime,
) {
    init {
        require(id > 0 && ownerAccountId > 0 && inputRevision > 0) { "stored review identifiers and revision must be positive" }
    }
}
