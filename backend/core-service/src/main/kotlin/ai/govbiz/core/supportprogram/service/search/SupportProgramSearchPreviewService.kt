package ai.govbiz.core.supportprogram.service.search

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.domain.SupportProgramSearchSnapshot
import ai.govbiz.core.supportprogram.facade.SupportProgramRankingFacade
import ai.govbiz.core.supportprogram.repository.SupportProgramSearchResultRepository
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchPreviewResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchRestoredResult
import ai.govbiz.core.supportprogram.service.search.exception.SupportProgramSearchResultExpiredException
import java.util.UUID
import org.springframework.stereotype.Service

/** 공개 검색은 익명에게 두 건만 제공하고, 로그인 후 같은 검색 결과를 모델 재호출 없이 복원합니다. */
@Service
class SupportProgramSearchPreviewService(
    private val searchService: SupportProgramSearchService,
    private val resultRepository: SupportProgramSearchResultRepository,
) {
    fun search(
        query: String,
        acceptingOnly: Boolean,
        companyConditions: SupportProgramCompanyConditions?,
        accountId: Long?,
    ): SupportProgramSearchPreviewResult {
        val searched = searchService.search(query, acceptingOnly, companyConditions)
        val programs = java.util.List.copyOf(searched.programs.take(SupportProgramRankingFacade.MAX_RESULTS).map(::copyProgram))
        val full = SupportProgramSearchPreviewResult(searched.query, programs, programs.size)
        if (accountId != null || programs.size <= GUEST_RESULT_LIMIT) return full

        val context = SupportProgramConversationContext(
            searched.query.takeIf(String::isNotBlank), acceptingOnly, companyConditions ?: SupportProgramCompanyConditions(),
        )
        val token = UUID.randomUUID().toString()
        val expiresAt = resultRepository.save(token, SupportProgramSearchSnapshot(full.query, programs, context))
        return full.copy(programs = java.util.List.copyOf(programs.take(GUEST_RESULT_LIMIT)), resultToken = token, expiresAt = expiresAt)
    }

    fun restore(resultToken: String, accountId: Long): SupportProgramSearchRestoredResult {
        val saved = resultRepository.claim(resultToken, accountId) ?: throw SupportProgramSearchResultExpiredException()
        val programs = java.util.List.copyOf(saved.programs.map(::copyProgram))
        return SupportProgramSearchRestoredResult(
            SupportProgramSearchPreviewResult(saved.query, programs, programs.size), saved.context,
        )
    }

    /** 내부의 목록까지 고정해 검색 호출자가 가진 컬렉션 변경이 로그인 후 결과에 섞이지 않게 합니다. */
    private fun copyProgram(program: SupportProgram): SupportProgram = program.copy(
        categories = java.util.List.copyOf(program.categories),
        regions = java.util.List.copyOf(program.regions),
        matchedReasons = java.util.List.copyOf(program.matchedReasons),
        eligibilityReview = program.eligibilityReview?.let { review ->
            review.copy(
                target = review.target.copy(evidence = java.util.List.copyOf(review.target.evidence)),
                region = review.region.copy(evidence = java.util.List.copyOf(review.region.evidence)),
            )
        },
    )

    private companion object {
        const val GUEST_RESULT_LIMIT = 2
    }
}
