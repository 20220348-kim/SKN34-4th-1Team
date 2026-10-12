package ai.govbiz.core.supportprogram.client.ai.dto

/** nullable 필드로 누락과 유효한 0점을 구분하는 내부 AI 응답 계약. */
data class AiSupportProgramRankingPayload(
    val originalQuery: String?,
    val scoringVersion: String?,
    val rankings: List<AiScoredSupportProgramPayload?>?,
    /** 추천에서 뺀 후보 수입니다. 이 필드를 보내기 전 AI Service 응답은 null입니다. */
    val exclusionCounts: AiSupportProgramRankingExclusionsPayload? = null,
)

data class AiSupportProgramRankingExclusionsPayload(
    val lowRelevance: Int?,
    val target: Int?,
    val region: Int?,
)

enum class AiSupportProgramEligibility {
    MATCH,
    INCOMPATIBLE,
    UNKNOWN,
}

data class AiScoredSupportProgramPayload(
    val programId: String?,
    val semanticRelevance: Int?,
    val targetEligibility: AiSupportProgramEligibility?,
    val regionEligibility: AiSupportProgramEligibility?,
    val supportTypeFit: Int?,
    val totalScore: Int?,
    val recommendationReasons: List<String?>?,
    val targetEvidence: List<AiSupportProgramEligibilityEvidencePayload?>? = null,
    val targetExplanation: String? = null,
    val regionEvidence: List<AiSupportProgramEligibilityEvidencePayload?>? = null,
    val regionExplanation: String? = null,
)

enum class AiSupportProgramEligibilityEvidenceField { SUMMARY, TARGET_DESCRIPTION }

data class AiSupportProgramEligibilityEvidencePayload(
    val field: AiSupportProgramEligibilityEvidenceField?,
    val quote: String?,
)
