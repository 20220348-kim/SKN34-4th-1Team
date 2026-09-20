package ai.govbiz.core.supportprogram.domain

import java.time.LocalDate

data class SupportProgram(
    val id: String,
    val sourceCode: String,
    val title: String,
    val organization: String,
    val summary: String,
    val categories: List<String>,
    val regions: List<String>,
    val targetDescription: String,
    val applicationPeriod: String,
    val applicationStartDate: LocalDate?,
    val applicationEndDate: LocalDate?,
    val status: SupportProgramStatus,
    val sourceName: String,
    val sourceUrl: String,
    val matchedReasons: List<String>,
    val recommendationScore: Int? = null,
    val eligibilityReview: SupportProgramEligibilityReview? = null,
) {
    init {
        require(SOURCE_CODE_PATTERN.matches(sourceCode)) {
            "sourceCode must be an uppercase provider code without a colon"
        }
        requireCanonicalSourceProgramId(id)
    }

    /** 서로 다른 제공처의 같은 원본 ID를 구분하는 내부 검색·AI 식별자입니다. */
    val sourceQualifiedId: String
        get() = "$sourceCode:$id"

    companion object {
        private const val MAX_SOURCE_PROGRAM_ID_CODE_POINTS = 255

        /** 외부 제공처 원본 ID와 내부 제공처 포함 ID가 공유하는 원본 ID 규칙입니다. */
        internal fun requireCanonicalSourceProgramId(value: String) {
            require(value.isNotBlank() && value == value.trim()) {
                "sourceProgramId must be a trimmed nonblank value"
            }
            require(value.codePointCount(0, value.length) <= MAX_SOURCE_PROGRAM_ID_CODE_POINTS) {
                "sourceProgramId must not exceed $MAX_SOURCE_PROGRAM_ID_CODE_POINTS code points"
            }
            require(!UNICODE_OTHER.containsMatchIn(value)) {
                "sourceProgramId must not contain Unicode other characters"
            }
        }

        /** 색인·AI 내부 계약에서 사용하는 제공처 포함 공고 식별자를 검증합니다. */
        internal fun requireCanonicalSourceQualifiedId(value: String) {
            val separator = value.indexOf(':')
            require(separator in 1 until value.lastIndex) {
                "program id must be canonical sourceCode:sourceProgramId"
            }

            val sourceCode = value.substring(0, separator)
            val sourceProgramId = value.substring(separator + 1)
            require(SOURCE_CODE_PATTERN.matches(sourceCode)) {
                "program id must be canonical sourceCode:sourceProgramId"
            }
            requireCanonicalSourceProgramId(sourceProgramId)
        }

        private val SOURCE_CODE_PATTERN = Regex("[A-Z][A-Z0-9_]{0,63}")
        private val UNICODE_OTHER = Regex("\\p{C}")
    }
}
