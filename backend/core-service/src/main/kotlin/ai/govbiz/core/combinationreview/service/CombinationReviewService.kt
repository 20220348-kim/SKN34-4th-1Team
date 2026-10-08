package ai.govbiz.core.combinationreview.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.combinationreview.domain.CombinationReviewDraft
import ai.govbiz.core.combinationreview.domain.StoredCombinationReview
import ai.govbiz.core.combinationreview.repository.CombinationReviewRepository
import ai.govbiz.core.combinationreview.service.dto.CombinationReviewPageResult
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewNotFoundException
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewRevisionConflictException
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.service.PlanUsageService
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

/** 세션에서 확인한 계정의 현재 입력만 다룬다. 관리자도 다른 소유자의 검토에 접근하지 않는다. */
@Service
class CombinationReviewService(
    private val repository: CombinationReviewRepository,
    private val planUsage: PlanUsageService,
    transactionManager: PlatformTransactionManager,
) {
    private val transactions = TransactionTemplate(transactionManager)

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

    /** keepRelation이면 draft의 관계 대신 저장된 관계를 유지한다(관계를 보내지 않는 화면의 저장). */
    fun replaceOwned(account: Account, reviewId: Long, expectedRevision: Long, draft: CombinationReviewDraft, keepRelation: Boolean = false) {
        // 성공한 PUT 뒤에 다시 조회하면 다른 요청의 새 버전이 섞일 수 있어 본문 없이 완료한다.
        if (repository.replaceOwned(account.id, reviewId, expectedRevision, draft, keepRelation)) return
        if (repository.findOwned(account.id, reviewId) == null) throw CombinationReviewNotFoundException()
        throw CombinationReviewRevisionConflictException()
    }

    /** 지운 검토가 이번 달에 쓴 분석 횟수는 같은 transaction에서 요금제 사용량에 남겨 삭제로 한도가 늘지 않게 한다. */
    fun deleteOwned(account: Account, reviewId: Long) {
        val deleted = transactions.execute { _ ->
            planUsage.keepMonthlyUsage(account.id, PlanUsageFeature.COMBINATION_REVIEW) { repository.deleteOwned(account.id, reviewId) }
        }
        if (deleted != true) throw CombinationReviewNotFoundException()
    }
}
