package ai.govbiz.core.combinationreview.domain

import java.util.Collections

/** 입력 중인 UI 폼이 아니라 검토 대상으로 확정한 사업과 참여 사실이다. */
data class SelectedReviewProgram(
    val identity: ReviewProgramIdentity,
    val participation: ProgramParticipation = ProgramParticipation(),
)

/** 무순서 사업쌍을 필드 순서로 정규화한 값. 허용·제한 여부를 담지 않는다. */
data class ReviewProgramPair(
    val first: ReviewProgramIdentity,
    val second: ReviewProgramIdentity,
) {
    init {
        require(ReviewProgramIdentity.ordering.compare(first, second) < 0) {
            "pair identities must be distinct and in canonical order"
        }
    }
}

/** 검토 가능한 두 사업의 불변 입력 스냅샷과 비교 대상 쌍을 구성한다. */
class CombinationReviewInput private constructor(programs: List<SelectedReviewProgram>, restoreLegacy: Boolean) {
    constructor(programs: List<SelectedReviewProgram>) : this(programs, false)

    val programs: List<SelectedReviewProgram> = Collections.unmodifiableList(ArrayList(programs))

    init {
        require(this.programs.size == 2 || restoreLegacy && this.programs.size == 3) { "a review requires exactly two programs" }
        require(this.programs.map { it.identity }.distinct().size == this.programs.size) {
            "a review must not contain duplicate program identities"
        }
    }

    /** 선택 순서가 바뀌어도 같은 사업쌍·같은 순서를 반환한다. 표시용 입력 순서는 보존한다. */
    fun programPairs(): List<ReviewProgramPair> {
        val identities = programs.map { it.identity }.sortedWith(ReviewProgramIdentity.ordering)
        return buildList {
            for (first in identities.indices) {
                for (second in first + 1 until identities.size) {
                    add(ReviewProgramPair(identities[first], identities[second]))
                }
            }
        }
    }

    companion object {
        /** 정책 변경 전에 저장한 세 사업 검토는 조회·결과 확인만 가능하도록 복원한다. */
        fun restore(programs: List<SelectedReviewProgram>): CombinationReviewInput = CombinationReviewInput(programs, true)
    }
}
