package ai.govbiz.core.chathistory.repository.mapper

import java.time.LocalDateTime

data class ChatConversationDbRow(
    var id: Long = 0,
    var accountId: Long = 0,
    var conversationId: String = "",
    var title: String = "",
    var snapshotJson: String? = null,
    var version: Long = 1,
    var updatedAt: LocalDateTime = LocalDateTime.MIN,
)
