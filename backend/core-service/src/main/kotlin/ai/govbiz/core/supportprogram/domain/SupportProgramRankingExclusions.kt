package ai.govbiz.core.supportprogram.domain

/**
 * 순위 매기기에 보낸 후보 수와 그중 추천에서 뺀 후보 수입니다.
 *
 * 한 후보는 먼저 걸린 사유 하나로만 셉니다(요청과 관련도 낮음 → 지원 대상 불일치 → 지역 불일치). 결과가 없을 때
 * 어떤 조건을 빼면 다시 찾아볼 만한지 알리는 용도이며, 조건을 빼고 다시 검색한 결과 수를 보장하지 않습니다.
 */
data class SupportProgramRankingExclusions(
    val candidateCount: Int,
    val lowRelevance: Int,
    val target: Int,
    val region: Int,
) {
    init {
        require(candidateCount >= 0 && lowRelevance >= 0 && target >= 0 && region >= 0) { "counts must not be negative" }
        require(lowRelevance + target + region <= candidateCount) { "excluded candidates exceed the candidates" }
    }

    companion object {
        /** 검색어에 맞는 후보가 없어 순위 매기기를 부르지 않았습니다. */
        val NO_CANDIDATES = SupportProgramRankingExclusions(0, 0, 0, 0)
    }
}
