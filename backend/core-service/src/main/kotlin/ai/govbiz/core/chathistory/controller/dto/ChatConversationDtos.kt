package ai.govbiz.core.chathistory.controller.dto

import ai.govbiz.core.chathistory.domain.ChatConversation
import jakarta.validation.constraints.Min
import java.time.LocalDateTime
import tools.jackson.databind.JsonNode

data class SaveChatConversationRequest(@field:Min(0) val expectedVersion: Long, val snapshot: JsonNode)
data class ChatConversationResponse(val id: String, val title: String, val version: Long, val updatedAt: LocalDateTime) {
    companion object {
        fun from(value: ChatConversation) = ChatConversationResponse(value.id, value.title, value.version, value.updatedAt)
    }
}
data class ChatConversationPageResponse(val items: List<ChatConversationResponse>, val nextCursor: Long?)
data class ChatConversationDetailResponse(val conversation: ChatConversationResponse, val snapshot: JsonNode)
