package ai.govbiz.core.chathistory.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.chathistory.controller.dto.ChatConversationDetailResponse
import ai.govbiz.core.chathistory.controller.dto.ChatConversationPageResponse
import ai.govbiz.core.chathistory.controller.dto.ChatConversationResponse
import ai.govbiz.core.chathistory.controller.dto.SaveChatConversationRequest
import ai.govbiz.core.chathistory.service.ChatConversationService
import jakarta.validation.Valid
import jakarta.validation.constraints.Positive
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.ObjectMapper
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** 소유자는 요청 본문이 아니라 검증된 세션에서만 가져옵니다. 다른 회원 기록은 관리자에게도 노출하지 않습니다. */
@RestController
@RequestMapping("/api/v1/me/chat-conversations")
class ChatConversationController(private val service: ChatConversationService, private val objectMapper: ObjectMapper) {
    @GetMapping
    fun list(account: Account, @RequestHeader("X-Chat-Account") expectedAccount: String, @RequestParam(required = false) @Positive before: Long?): ResponseEntity<ChatConversationPageResponse> {
        requireSameAccount(account, expectedAccount)
        val rows = service.list(account, before)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ChatConversationPageResponse(
            rows.take(30).map(ChatConversationResponse::from), if (rows.size > 30) rows[29].rowId else null,
        ))
    }

    @GetMapping("/{id}")
    fun get(account: Account, @RequestHeader("X-Chat-Account") expectedAccount: String, @PathVariable id: String): ResponseEntity<ChatConversationDetailResponse> {
        requireSameAccount(account, expectedAccount)
        val value = service.get(account, id)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
            ChatConversationDetailResponse(ChatConversationResponse.from(value), objectMapper.readTree(requireNotNull(value.snapshotJson))),
        )
    }

    @PutMapping("/{id}")
    fun save(account: Account, @RequestHeader("X-Chat-Account") expectedAccount: String, @PathVariable id: String, @RequestBody @Valid request: SaveChatConversationRequest): ResponseEntity<ChatConversationResponse> {
        requireSameAccount(account, expectedAccount)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(ChatConversationResponse.from(
            service.save(account, id, request.expectedVersion, request.snapshot.toString()),
        ))
    }

    @DeleteMapping("/{id}")
    fun delete(account: Account, @RequestHeader("X-Chat-Account") expectedAccount: String, @PathVariable id: String): ResponseEntity<Void> {
        requireSameAccount(account, expectedAccount)
        service.delete(account, id)
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build()
    }

    private fun requireSameAccount(account: Account, expectedAccount: String) {
        if (runCatching { URLDecoder.decode(expectedAccount, StandardCharsets.UTF_8) }.getOrNull() != account.email) throw AuthenticationRequiredException()
    }
}
