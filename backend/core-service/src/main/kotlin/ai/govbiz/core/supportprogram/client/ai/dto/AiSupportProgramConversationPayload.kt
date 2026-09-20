package ai.govbiz.core.supportprogram.client.ai.dto

import com.fasterxml.jackson.annotation.JsonProperty

/** 필수 필드 누락을 거부하며 answer 생략은 이전 응답과 호환되도록 null로 읽습니다. */
data class AiSupportProgramConversationPayload(
    @param:JsonProperty(required = true) val schemaVersion: String?,
    @param:JsonProperty(required = true) val status: String?,
    @param:JsonProperty(required = true) val updates: List<AiSupportProgramConversationUpdatePayload?>?,
    @param:JsonProperty(required = true) val clarificationQuestion: String?,
    val answer: String? = null,
)

data class AiSupportProgramConversationUpdatePayload(
    @param:JsonProperty(required = true) val field: String?,
    @param:JsonProperty(required = true) val operation: String?,
    @param:JsonProperty(required = true) val value: String?,
    @param:JsonProperty(required = true) val evidence: String?,
)
