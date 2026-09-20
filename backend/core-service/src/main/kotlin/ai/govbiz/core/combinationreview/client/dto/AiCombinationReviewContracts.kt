package ai.govbiz.core.combinationreview.client.dto

const val AI_COMBINATION_REVIEW_CONTRACT_VERSION = "combination-review-v2"

data class AiReviewConfigurationPayload(val contractVersion: String, val model: String, val promptVersion: String)
data class AiCombinationReviewRequest(
    val contractVersion: String, val programs: List<AiReviewProgramRequest>, val asOfDate: String,
    val additionalFacts: String, val evidence: List<AiReviewEvidenceRequest>, val coverageWarnings: List<String>,
)
data class AiReviewProgramRequest(val sourceCode: String, val sourceProgramId: String, val subProgramId: String?, val participation: AiReviewParticipationRequest)
data class AiReviewParticipationRequest(
    val applicationSubmitted: String, val selected: String, val commitmentSubmitted: String,
    val agreementSigned: String, val executionStatus: String, val fundingReceived: String,
)
data class AiReviewEvidenceRequest(val id: String, val programIndex: Int, val documentHash: String, val locator: String, val text: String)
data class AiCombinationReviewPayload(
    val contractVersion: String, val model: String, val promptVersion: String,
    val summary: String, val pairs: List<AiReviewPairPayload>, val limitations: List<String>,
)
data class AiReviewPairPayload(val firstProgramIndex: Int, val secondProgramIndex: Int, val stages: List<AiReviewStagePayload>)
data class AiReviewStagePayload(
    val stage: String, val judgment: String, val scope: String, val explanation: String,
    val questions: List<String>, val requiresInstitutionConfirmation: Boolean, val citations: List<AiReviewCitationPayload>,
)
data class AiReviewCitationPayload(val evidenceId: String, val quote: String)
