package ai.govbiz.core.chathistory.domain

import java.time.LocalDateTime

/** 회원이 보관한 대화 화면 스냅샷입니다. 검색 재실행이나 서버가 보증한 검색 결과의 근거로 사용하지 않습니다. */
data class ChatConversation(
    val rowId: Long,
    val id: String,
    val title: String,
    val version: Long,
    val updatedAt: LocalDateTime,
    val snapshotJson: String? = null,
)
