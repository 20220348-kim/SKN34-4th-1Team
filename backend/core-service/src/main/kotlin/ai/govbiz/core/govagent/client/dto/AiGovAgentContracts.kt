package ai.govbiz.core.govagent.client.dto

data class AiGovAgentRequest(
    val message: String,
    val hasSelectedProgram: Boolean,
    val searchQuery: String?,
    val pendingSearchQuestion: String?,
)

data class AiGovAgentPayload(
    val action: String? = null,
    /** PARTNERS일 때 사용자가 말한 모집글 조건입니다. 값·근거 문구는 Core가 다시 검증합니다. */
    val partnerConditions: AiGovPartnerConditionsPayload? = null,
)

data class AiGovPartnerConditionsPayload(
    val seekingRoles: List<AiGovPartnerConditionPayload?>? = null,
    val regions: List<AiGovPartnerConditionPayload?>? = null,
    val keywords: List<AiGovPartnerConditionPayload?>? = null,
    val selectedProgramEvidence: String? = null,
)

data class AiGovPartnerConditionPayload(val value: String? = null, val evidence: String? = null)
