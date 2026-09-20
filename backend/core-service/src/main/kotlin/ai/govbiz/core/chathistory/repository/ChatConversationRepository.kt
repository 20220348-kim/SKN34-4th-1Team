package ai.govbiz.core.chathistory.repository

import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.chathistory.domain.ChatConversation
import ai.govbiz.core.chathistory.repository.mapper.ChatConversationDbRow
import ai.govbiz.core.chathistory.repository.mapper.ChatConversationMapper
import ai.govbiz.core.chathistory.service.exception.ChatConversationConflictException
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

@Repository
class ChatConversationRepository(
    private val mapper: ChatConversationMapper,
    private val objectMapper: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun findPage(accountId: Long, before: Long?): List<ChatConversation> = mapper.findPage(accountId, before).map(::toDomain)
    fun find(accountId: Long, id: String): ChatConversation? = mapper.find(accountId, id)?.let(::toDomain)

    /** 계정 행 잠금으로 신규 생성·버전 검사·갱신을 직렬화하고 탈퇴 후 저장도 차단합니다. 외부 호출은 없습니다. */
    @Transactional
    fun save(accountId: Long, id: String, expectedVersion: Long, title: String, snapshotJson: String): ChatConversation {
        if (mapper.lockActiveAccount(accountId) == null) throw AuthenticationRequiredException()
        if (mapper.isDeleted(accountId, id)) throw ChatConversationConflictException()
        val existing = mapper.find(accountId, id)
        // 응답 유실 뒤 같은 내용으로 재시도해도 버전을 다시 올리지 않습니다. MySQL의 JSON 키 순서는 비교에 영향이 없습니다.
        if (existing != null && objectMapper.readTree(existing.snapshotJson) == objectMapper.readTree(snapshotJson)) return toDomain(existing)
        if ((existing?.version ?: 0) != expectedVersion) throw ChatConversationConflictException()
        val row = ChatConversationDbRow(
            id = existing?.id ?: 0, accountId = accountId, conversationId = id, title = title,
            snapshotJson = snapshotJson, version = expectedVersion + 1, updatedAt = LocalDateTime.now(clock),
        )
        if (existing == null) mapper.insert(row) else mapper.update(row)
        return toDomain(row)
    }

    fun deleteByAccountId(accountId: Long) { mapper.deleteByAccountId(accountId) }

    /** 저장과 같은 계정 잠금을 사용합니다. 먼저 도착한 삭제도 늦은 최초 저장으로 되살아나지 않습니다. */
    @Transactional
    fun delete(accountId: Long, id: String) {
        if (mapper.lockActiveAccount(accountId) == null) throw AuthenticationRequiredException()
        mapper.markDeleted(accountId, id, LocalDateTime.now(clock))
    }

    private fun toDomain(row: ChatConversationDbRow) = ChatConversation(row.id, row.conversationId, row.title, row.version, row.updatedAt, row.snapshotJson)
}
