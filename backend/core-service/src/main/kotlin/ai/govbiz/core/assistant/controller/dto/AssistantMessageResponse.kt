package ai.govbiz.core.assistant.controller.dto

import ai.govbiz.core.assistant.domain.AssistantAnswer
import ai.govbiz.core.assistant.domain.AssistantCard

/**
 * 도우미 답 한 건입니다. 프런트는 `intent`로 말풍선 모양을 정하고 `navigation`으로 버튼 하나를 붙이며,
 * `cards`가 있으면 항목 목록(모집글·공고)을 제목 링크와 이유 한 줄로 그립니다.
 */
data class AssistantMessageResponse(
    val intent: String,
    val answer: String?,
    val citations: List<String>,
    val clarificationQuestion: String?,
    val searchQuery: String?,
    val accountTopic: String?,
    val navigation: AssistantNavigationResponse?,
    val cards: List<AssistantCardResponse>,
) {
    companion object {
        fun from(answer: AssistantAnswer) = AssistantMessageResponse(
            answer.intent.name,
            answer.answer,
            answer.citations,
            answer.clarificationQuestion,
            answer.searchQuery,
            answer.accountTopic?.name,
            answer.navigation?.let { AssistantNavigationResponse(it.label, it.to) },
            answer.cards.map(AssistantCardResponse::from),
        )
    }
}

data class AssistantNavigationResponse(
    val label: String,
    val to: String,
)

data class AssistantCardResponse(
    val kind: String,
    val id: String,
    val title: String,
    val subtitle: String?,
    val reason: String,
    val quote: String?,
    val to: String,
) {
    companion object {
        fun from(card: AssistantCard) =
            AssistantCardResponse(card.kind.name, card.id, card.title, card.subtitle, card.reason, card.quote, card.to)
    }
}
