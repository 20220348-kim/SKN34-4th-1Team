package ai.govbiz.core.chathistory.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.service.dto.AccountDeletedEvent
import ai.govbiz.core.chathistory.domain.ChatConversation
import ai.govbiz.core.chathistory.repository.ChatConversationRepository
import ai.govbiz.core.chathistory.service.exception.ChatConversationNotFoundException
import ai.govbiz.core.chathistory.service.exception.InvalidChatConversationException
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper

@Service
class ChatConversationService(private val repository: ChatConversationRepository, private val objectMapper: ObjectMapper) {
    fun list(account: Account, before: Long?) = repository.findPage(account.id, before)
    fun get(account: Account, id: String) = repository.find(account.id, id) ?: throw ChatConversationNotFoundException()

    fun delete(account: Account, id: String) {
        if (!id.matches(Regex("[A-Za-z0-9_-]{1,64}"))) throw InvalidChatConversationException()
        repository.delete(account.id, id)
    }

    fun save(account: Account, id: String, expectedVersion: Long, snapshotJson: String): ChatConversation {
        if (!id.matches(Regex("[A-Za-z0-9_-]{1,64}")) || expectedVersion !in 0..9_007_199_254_740_990L
            || snapshotJson.toByteArray(Charsets.UTF_8).size > 2_000_000) throw InvalidChatConversationException()
        val snapshot = objectMapper.readTree(snapshotJson)
        val messages = snapshot.path("messages")
        if (!snapshot.isObject || !snapshot.path("schemaVersion").isIntegralNumber || snapshot.path("schemaVersion").asInt() != 1 || !messages.isArray
            || messages.size() !in 1..200) throw InvalidChatConversationException()
        val messageIds = mutableSetOf<String>()
        for (message in messages) {
            if (!message.isObject || !message.path("id").isString || message.path("id").asString().length !in 1..128
                || message.path("role").asString() !in setOf("user", "assistant") || !message.path("text").isString
                || message.path("text").asString().length > 10_000 || !messageIds.add(message.path("id").asString())) throw InvalidChatConversationException()
        }
        val firstQuestion = messages.firstOrNull { it.path("role").asString() == "user" } ?: throw InvalidChatConversationException()
        if (firstQuestion.path("id").asString() != id || firstQuestion.path("text").asString().isBlank()) throw InvalidChatConversationException()
        val titleCodePoints = firstQuestion.path("text").asString().trim().replace(Regex("\\s+"), " ").codePoints().limit(80).toArray()
        val title = String(titleCodePoints, 0, titleCodePoints.size)
        return repository.save(account.id, id, expectedVersion, title, snapshotJson)
    }

    /** 탈퇴 transaction 안에서 개인 대화도 제거합니다. 실패하면 탈퇴 전체가 rollback됩니다. */
    @EventListener
    fun onAccountDeleted(event: AccountDeletedEvent) { repository.deleteByAccountId(event.accountId) }
}
