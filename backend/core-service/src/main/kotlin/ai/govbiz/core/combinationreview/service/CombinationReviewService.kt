package ai.govbiz.core.combinationreview.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.combinationreview.domain.CombinationReviewDraft
import ai.govbiz.core.combinationreview.domain.StoredCombinationReview
import ai.govbiz.core.combinationreview.repository.CombinationReviewRepository
import ai.govbiz.core.combinationreview.service.dto.CombinationReviewPageResult
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewNotFoundException
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewRevisionConflictException
import org.springframework.stereotype.Service

/** 세션에서 확인한 계정의 현재 입력만 다룬다. 관리자도 다른 소유자의 검토에 접근하지 않는다. */
@Service
class CombinationReviewService(private val repository: CombinationReviewRepository) {
    fun create(account: Account, draft: CombinationReviewDraft): StoredCombinationReview =
        repository.create(account.id, draft)

    fun findOwned(account: Account, reviewId: Long): StoredCombinationReview =
        repository.findOwned(account.id, reviewId) ?: throw CombinationReviewNotFoundException()

    fun listOwned(account: Account, beforeId: Long?, size: Int): CombinationReviewPageResult {
        require(size in 1..50 && (beforeId == null || beforeId > 0))
        val rows = repository.listOwned(account.id, beforeId, size + 1)
        val items = rows.take(size)
        return CombinationReviewPageResult(items, items.lastOrNull()?.id?.takeIf { rows.size > size })
    }

    fun replaceOwned(account: Account, reviewId: Long, expectedRevision: Long, draft: CombinationReviewDraft) {
        // 성공한 PUT 뒤에 다시 조회하면 다른 요청의 새 버전이 섞일 수 있어 본문 없이 완료한다.
        if (repository.replaceOwned(account.id, reviewId, expectedRevision, draft)) return
        if (repository.findOwned(account.id, reviewId) == null) throw CombinationReviewNotFoundException()
        throw CombinationReviewRevisionConflictException()
    }

    fun deleteOwned(account: Account, reviewId: Long) {
        if (!repository.deleteOwned(account.id, reviewId)) throw CombinationReviewNotFoundException()
    }
}
