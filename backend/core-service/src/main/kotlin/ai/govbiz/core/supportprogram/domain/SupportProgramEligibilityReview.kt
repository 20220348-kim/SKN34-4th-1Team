package ai.govbiz.core.supportprogram.domain

/** 이번 검색의 공식 API 본문 기반 자격 검토이며 첨부파일 전체를 확인한 판정은 아닙니다. */
data class SupportProgramEligibilityReview(
    val status: SupportProgramEligibilityReviewStatus,
    val target: SupportProgramEligibilityAssessment,
    val region: SupportProgramEligibilityAssessment,
)

enum class SupportProgramEligibilityReviewStatus { MATCH, REVIEW_REQUIRED }

enum class SupportProgramEligibilityStatus { MATCH, UNKNOWN }

enum class SupportProgramEligibilityEvidenceField { SUMMARY, TARGET_DESCRIPTION }

data class SupportProgramEligibilityAssessment(
    val status: SupportProgramEligibilityStatus,
    val explanation: String,
    val evidence: List<SupportProgramEligibilityEvidence>,
)

data class SupportProgramEligibilityEvidence(
    val field: SupportProgramEligibilityEvidenceField,
    val quote: String,
)
