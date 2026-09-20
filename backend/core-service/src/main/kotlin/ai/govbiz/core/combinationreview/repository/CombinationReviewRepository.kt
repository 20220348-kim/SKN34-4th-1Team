package ai.govbiz.core.combinationreview.repository

import ai.govbiz.core.combinationreview.domain.CombinationReviewDraft
import ai.govbiz.core.combinationreview.domain.CombinationReviewInput
import ai.govbiz.core.combinationreview.domain.CombinationReviewSummary
import ai.govbiz.core.combinationreview.domain.ParticipationAnswer
import ai.govbiz.core.combinationreview.domain.ProgramExecutionStatus
import ai.govbiz.core.combinationreview.domain.ProgramParticipation
import ai.govbiz.core.combinationreview.domain.ReviewProgramIdentity
import ai.govbiz.core.combinationreview.domain.SelectedReviewProgram
import ai.govbiz.core.combinationreview.domain.StoredCombinationReview
import ai.govbiz.core.combinationreview.repository.mapper.CombinationReviewDbRow
import ai.govbiz.core.combinationreview.repository.mapper.CombinationReviewMapper
import ai.govbiz.core.combinationreview.repository.mapper.CombinationReviewProgramDbRow
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Isolation
import org.springframework.transaction.annotation.Transactional

/** 현재 검토 입력을 소유자 범위에서 저장·조회한다. 인증된 계정 결정은 호출하는 Service의 책임이다. */
@Repository
class CombinationReviewRepository(
    private val mapper: CombinationReviewMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    @Transactional
    fun create(ownerAccountId: Long, draft: CombinationReviewDraft): StoredCombinationReview {
        require(ownerAccountId > 0) { "ownerAccountId must be positive" }
        val now = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
        val row = CombinationReviewDbRow(
            ownerAccountId = ownerAccountId,
            title = draft.title,
            createdAt = now,
            updatedAt = now,
        )
        check(mapper.insertReview(row) == 1 && row.id > 0) { "review was not created" }
        insertPrograms(row.id, draft.input)
        return StoredCombinationReview(
            id = row.id,
            ownerAccountId = ownerAccountId,
            inputRevision = 1,
            draft = draft,
            createdAt = now,
            updatedAt = now,
        )
    }

    /** 두 SELECT가 같은 DB 스냅샷을 읽도록 하여 부모 버전과 사업 목록이 서로 다른 시점에 섞이지 않게 한다. */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    fun findOwned(ownerAccountId: Long, reviewId: Long): StoredCombinationReview? {
        require(ownerAccountId > 0 && reviewId > 0) { "ownerAccountId and reviewId must be positive" }
        val row = mapper.findReview(ownerAccountId, reviewId) ?: return null
        val input = CombinationReviewInput.restore(mapper.findPrograms(ownerAccountId, reviewId).map { it.toDomain() })
        return StoredCombinationReview(
            id = row.id,
            ownerAccountId = row.ownerAccountId,
            inputRevision = row.inputRevision,
            draft = CombinationReviewDraft(row.title, input),
            createdAt = requireNotNull(row.createdAt),
            updatedAt = requireNotNull(row.updatedAt),
        )
    }

    /** 생성 ID 내림차순 커서 조회. 수정해도 목록 위치가 바뀌지 않는다. */
    @Transactional(readOnly = true)
    fun listOwned(ownerAccountId: Long, beforeId: Long?, limit: Int): List<CombinationReviewSummary> {
        require(ownerAccountId > 0 && (beforeId == null || beforeId > 0) && limit in 1..51)
        return mapper.listReviews(ownerAccountId, beforeId, limit).map { row ->
            CombinationReviewSummary(
                row.id, row.title, row.inputRevision, requireNotNull(row.createdAt), requireNotNull(row.updatedAt),
            )
        }
    }

    /**
     * 부모 행의 소유자·버전 비교 후 사업 목록을 하나의 transaction에서 교체한다.
     * false는 없음·다른 소유자·버전 충돌을 구분해 노출하지 않는다. HTTP 오류 변환은 Service가 담당한다.
     */
    @Transactional
    fun replaceOwned(
        ownerAccountId: Long,
        reviewId: Long,
        expectedRevision: Long,
        draft: CombinationReviewDraft,
    ): Boolean {
        require(ownerAccountId > 0 && reviewId > 0) { "ownerAccountId and reviewId must be positive" }
        require(expectedRevision in 1 until Long.MAX_VALUE) { "expectedRevision must be positive and incrementable" }
        val changed = mapper.updateReviewIfRevisionMatches(
            ownerAccountId = ownerAccountId,
            reviewId = reviewId,
            expectedRevision = expectedRevision,
            title = draft.title,
            updatedAt = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS),
        )
        if (changed == 0) return false
        check(changed == 1) { "unexpected review update count" }
        mapper.deletePrograms(ownerAccountId, reviewId)
        insertPrograms(reviewId, draft.input)
        return true
    }

    /** 부모 삭제로 선택 공고, 실행 이력과 보관 원문까지 FK 순서대로 함께 삭제한다. */
    @Transactional
    fun deleteOwned(ownerAccountId: Long, reviewId: Long): Boolean {
        require(ownerAccountId > 0 && reviewId > 0) { "ownerAccountId and reviewId must be positive" }
        return when (val deleted = mapper.deleteReview(ownerAccountId, reviewId)) {
            0 -> false
            1 -> true
            else -> error("unexpected review delete count: $deleted")
        }
    }

    private fun insertPrograms(reviewId: Long, input: CombinationReviewInput) {
        input.programs.forEachIndexed { position, program ->
            val facts = program.participation
            check(
                mapper.insertProgram(
                    CombinationReviewProgramDbRow(
                        reviewId = reviewId,
                        position = position,
                        sourceCode = program.identity.sourceCode,
                        sourceProgramId = program.identity.sourceProgramId,
                        subProgramId = program.identity.subProgramId,
                        applicationSubmitted = facts.applicationSubmitted.name,
                        selected = facts.selected.name,
                        commitmentSubmitted = facts.commitmentSubmitted.name,
                        agreementSigned = facts.agreementSigned.name,
                        executionStatus = facts.executionStatus.name,
                        fundingReceived = facts.fundingReceived.name,
                    ),
                ) == 1,
            ) { "review program was not inserted" }
        }
    }

    private fun CombinationReviewProgramDbRow.toDomain(): SelectedReviewProgram =
        SelectedReviewProgram(
            ReviewProgramIdentity(sourceCode, sourceProgramId, subProgramId),
            ProgramParticipation(
                applicationSubmitted = ParticipationAnswer.valueOf(applicationSubmitted),
                selected = ParticipationAnswer.valueOf(selected),
                commitmentSubmitted = ParticipationAnswer.valueOf(commitmentSubmitted),
                agreementSigned = ParticipationAnswer.valueOf(agreementSigned),
                executionStatus = ProgramExecutionStatus.valueOf(executionStatus),
                fundingReceived = ParticipationAnswer.valueOf(fundingReceived),
            ),
        )
}
