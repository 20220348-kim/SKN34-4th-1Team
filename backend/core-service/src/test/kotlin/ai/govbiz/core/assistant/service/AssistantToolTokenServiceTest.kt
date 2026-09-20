package ai.govbiz.core.assistant.service

import ai.govbiz.core.assistant.config.AssistantAgentProperties
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AssistantToolTokenServiceTest {
    private val secret = "assistant-tools-secret-for-tests-0123456789"
    private val now = Instant.parse("2026-09-14T09:00:00Z")
    private val properties = AssistantAgentProperties(agentEnabled = true, toolsSecret = secret, toolTokenTtl = Duration.ofMinutes(5))
    private val service = AssistantToolTokenService(properties, Clock.fixed(now, ZoneOffset.UTC))

    @Test
    fun issuesATokenBoundToTheAccountThatVerifiesUntilItExpires() {
        val token = service.issue(7L)
        assertEquals(now.plusSeconds(300), token.expiresAt)
        assertTrue(service.verify(token.value, 7L))
        assertFalse(service.verify(token.value, 8L), "다른 계정으로는 통과하지 않습니다")
        val later = AssistantToolTokenService(properties, Clock.fixed(now.plusSeconds(301), ZoneOffset.UTC))
        assertFalse(later.verify(token.value, 7L), "만료 뒤에는 통과하지 않습니다")
    }

    @Test
    fun rejectsTamperedMalformedAndForeignSignatures() {
        val token = service.issue(7L).value
        val (account, expiry, signature) = token.split('.')
        assertFalse(service.verify("$account.${expiry.toLong() + 600}.$signature", 7L), "만료 시각을 늘리면 서명이 깨집니다")
        assertFalse(service.verify("8.$expiry.$signature", 8L), "계정을 바꾸면 서명이 깨집니다")
        assertFalse(service.verify("$account.$expiry", 7L))
        assertFalse(service.verify("", 7L))
        assertFalse(service.verify(null, 7L))
        val other = AssistantToolTokenService(properties.copy(toolsSecret = "another-secret-that-is-long-enough-0123456789"), Clock.fixed(now, ZoneOffset.UTC))
        assertFalse(other.verify(token, 7L), "다른 비밀로 만든 서명은 통과하지 않습니다")
    }

    @Test
    fun matchesTheSharedSecretOnlyExactly() {
        assertTrue(service.matchesSecret(secret))
        assertFalse(service.matchesSecret("$secret "))
        assertFalse(service.matchesSecret(null))
    }

    @Test
    fun disabledToolsNeitherIssueNorVerify() {
        val disabled = AssistantToolTokenService(AssistantAgentProperties(toolsSecret = "short"), Clock.fixed(now, ZoneOffset.UTC))
        assertThrows(IllegalArgumentException::class.java) { disabled.issue(7L) }
        assertFalse(disabled.verify(service.issue(7L).value, 7L))
        assertFalse(disabled.matchesSecret("short"))
    }

    @Test
    fun propertiesRequireASecretWhenTheAgentIsOn() {
        assertThrows(IllegalArgumentException::class.java) { AssistantAgentProperties(agentEnabled = true, toolsSecret = "") }
        assertFalse(AssistantAgentProperties().toolsEnabled)
        assertTrue(properties.toolsEnabled)
    }
}
