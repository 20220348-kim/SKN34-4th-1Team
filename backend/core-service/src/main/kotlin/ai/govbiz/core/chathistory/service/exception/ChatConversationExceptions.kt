package ai.govbiz.core.chathistory.service.exception

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.ResponseStatus

@ResponseStatus(HttpStatus.CONFLICT, reason = "다른 창에서 변경된 대화입니다. 기록을 다시 열어 주세요.")
class ChatConversationConflictException : RuntimeException()

@ResponseStatus(HttpStatus.NOT_FOUND, reason = "대화 기록을 찾을 수 없습니다.")
class ChatConversationNotFoundException : RuntimeException()

@ResponseStatus(HttpStatus.BAD_REQUEST, reason = "대화 기록의 형식이나 크기를 확인해 주세요.")
class InvalidChatConversationException : RuntimeException()
