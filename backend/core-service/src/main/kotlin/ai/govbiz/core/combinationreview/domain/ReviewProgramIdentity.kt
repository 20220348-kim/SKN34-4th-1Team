package ai.govbiz.core.combinationreview.domain

import ai.govbiz.core.supportprogram.domain.SupportProgram

/** 공고와 선택적인 세부사업의 식별자. 실제 지원 대상인지의 확인은 Service가 담당한다. */
data class ReviewProgramIdentity(
    val sourceCode: String,
    val sourceProgramId: String,
    val subProgramId: String? = null,
) {
    init {
        require(PROVIDER_CODE.matches(sourceCode)) { "sourceCode must be an uppercase provider code" }
        SupportProgram.requireCanonicalSourceProgramId(sourceProgramId)
        subProgramId?.let {
            require(it.isNotBlank() && it == it.trim()) { "subProgramId must be trimmed and nonblank" }
            require(it.codePointCount(0, it.length) <= 255 && !UNICODE_OTHER.containsMatchIn(it)) {
                "subProgramId must be at most 255 code points without Unicode other characters"
            }
        }
    }

    internal companion object {
        private val PROVIDER_CODE = Regex("[A-Z][A-Z0-9_]{0,63}")
        private val UNICODE_OTHER = Regex("\\p{C}")

        /** 구분자를 이어 붙이지 않고 각 필드를 비교해 서로 다른 식별자가 충돌하지 않게 한다. */
        val ordering: Comparator<ReviewProgramIdentity> =
            compareBy<ReviewProgramIdentity> { it.sourceCode }
                .thenBy { it.sourceProgramId }
                .thenBy { it.subProgramId }
    }
}
