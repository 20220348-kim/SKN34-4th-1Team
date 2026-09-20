package ai.govbiz.core.assistant.controller.dto

import ai.govbiz.core.assistant.domain.AssistantHelpEntry
import ai.govbiz.core.assistant.domain.AssistantHistoryMessage
import ai.govbiz.core.assistant.domain.AssistantHistoryRole
import ai.govbiz.core.assistant.domain.AssistantNavigation
import ai.govbiz.core.assistant.domain.AssistantQuestion
import ai.govbiz.core.assistant.domain.AssistantScreenContext
import com.fasterxml.jackson.annotation.JsonIgnore
import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonSetter
import com.fasterxml.jackson.annotation.Nulls
import jakarta.validation.Valid
import jakarta.validation.constraints.AssertTrue
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

private const val TEXT = "(?Us)^(?!\\s*$)(?!.*\\p{C}).*$"
private const val LAYOUT_TEXT = "(?Us)^(?!\\s*$)(?!.*[\\p{C}&&[^\\n\\r\\t]]).*$"
private const val ROUTE = "/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*"

/**
 * 도우미 자유 질문 요청입니다. 도움말 항목은 프런트가 원본을 갖고 있어 요청에 전량 실어 보내며,
 * Core는 그 항목 안에서만 인용과 이동 버튼을 인정합니다. 상한은 AI Service 계약과 같습니다.
 */
data class AssistantMessageRequest(
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 500)
    @field:Pattern(regexp = LAYOUT_TEXT)
    val message: String,
    @param:JsonProperty(required = true)
    @field:Size(max = 6)
    @field:Valid
    val history: List<AssistantHistoryMessageRequest>,
    @param:JsonProperty(required = true)
    @field:Valid
    val context: AssistantContextRequest,
    @param:JsonProperty(required = true)
    @field:Size(min = 1, max = 40)
    @field:Valid
    val helpEntries: List<AssistantHelpEntryRequest>,
) {
    @get:AssertTrue
    @get:JsonIgnore
    val helpEntryIdsUnique: Boolean
        get() = helpEntries.map { it.id }.toSet().size == helpEntries.size

    fun toDomain() = AssistantQuestion(
        message,
        history.map { AssistantHistoryMessage(AssistantHistoryRole.valueOf(it.role), it.content) },
        AssistantScreenContext(context.route, context.programSelected),
        helpEntries.map { it.toDomain() },
    )
}

data class AssistantHistoryMessageRequest(
    @param:JsonProperty(required = true)
    @field:Pattern(regexp = "USER|ASSISTANT")
    val role: String,
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 1000)
    @field:Pattern(regexp = LAYOUT_TEXT)
    val content: String,
)

data class AssistantContextRequest(
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 200)
    @field:Pattern(regexp = ROUTE)
    val route: String,
    @param:JsonProperty(required = true)
    @field:JsonSetter(nulls = Nulls.FAIL)
    val programSelected: Boolean,
)

data class AssistantHelpActionRequest(
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 160)
    @field:Pattern(regexp = TEXT)
    val label: String,
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 200)
    @field:Pattern(regexp = ROUTE)
    val to: String,
)

data class AssistantHelpEntryRequest(
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 64)
    @field:Pattern(regexp = "[a-z0-9]+(-[a-z0-9]+)*")
    val id: String,
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 160)
    @field:Pattern(regexp = TEXT)
    val title: String,
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 160)
    @field:Pattern(regexp = TEXT)
    val question: String,
    @param:JsonProperty(required = true)
    @field:NotBlank
    @field:Size(max = 600)
    @field:Pattern(regexp = LAYOUT_TEXT)
    val summary: String,
    @param:JsonProperty(required = true)
    @field:Size(max = 10)
    val body: List<String>,
    @param:JsonProperty(required = true)
    @field:Size(max = 600)
    @field:Pattern(regexp = LAYOUT_TEXT)
    val limitation: String?,
    @param:JsonProperty(required = true)
    @field:Pattern(regexp = "public|member|company|admin")
    val audience: String,
    @param:JsonProperty(required = true)
    @field:Pattern(regexp = "available|demo|planned")
    val status: String,
    @param:JsonProperty(required = true)
    @field:Valid
    val action: AssistantHelpActionRequest?,
) {
    @get:AssertTrue
    @get:JsonIgnore
    val bodyParagraphsValid: Boolean
        get() = body.all { it.isNotBlank() && it.length <= 600 && !BODY_CONTROL.containsMatchIn(it) }

    fun toDomain() = AssistantHelpEntry(
        id, title, question, summary, body, limitation, audience, status,
        action?.let { AssistantNavigation(it.label, it.to) },
    )

    private companion object {
        val BODY_CONTROL = Regex("[\\p{C}&&[^\\n\\r\\t]]")
    }
}
