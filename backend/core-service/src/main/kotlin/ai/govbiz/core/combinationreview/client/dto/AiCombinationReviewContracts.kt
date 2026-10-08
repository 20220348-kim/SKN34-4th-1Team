package ai.govbiz.core.combinationreview.client.dto

const val AI_COMBINATION_REVIEW_CONTRACT_VERSION = "combination-review-v2"
const val AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION = "combination-review-v3"

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

/** `combination-review-v3` 요청. 사업별 참여 사실 대신 상태 4값과 검토 단위 관계를 보낸다. evidence 제약은 v2와 같다. */
data class AiCombinationReviewV3Request(
    val contractVersion: String, val programs: List<AiReviewProgramV3Request>, val relation: AiReviewRelationRequest,
    val asOfDate: String, val additionalFacts: String, val evidence: List<AiReviewEvidenceRequest>, val coverageWarnings: List<String>,
)
data class AiReviewProgramV3Request(val sourceCode: String, val sourceProgramId: String, val subProgramId: String?, val status: String)
data class AiReviewRelationRequest(val sameProject: String, val sameCost: String)

/** `combination-review-v3` 응답. 사업쌍마다 세 질문의 판정·조건·걸리면 생기는 일·기관 확인 문장을 받는다. */
data class AiCombinationReviewV3Payload(
    val contractVersion: String, val model: String, val promptVersion: String,
    val summary: String, val pairs: List<AiReviewPairV3Payload>, val limitations: List<String>,
)
data class AiReviewPairV3Payload(val firstProgramIndex: Int, val secondProgramIndex: Int, val answers: List<AiReviewAnswerPayload>)
data class AiReviewAnswerPayload(
    val question: String, val verdict: String, val explanation: String,
    val conditions: List<AiReviewConditionPayload>, val consequences: List<AiReviewConsequencePayload>,
    val institutionQuestion: String, val citations: List<AiReviewCitationPayload>,
)
data class AiReviewConditionPayload(val condition: String, val result: String, val citations: List<AiReviewCitationPayload>)
data class AiReviewConsequencePayload(val moment: String, val action: String, val citations: List<AiReviewCitationPayload>)
