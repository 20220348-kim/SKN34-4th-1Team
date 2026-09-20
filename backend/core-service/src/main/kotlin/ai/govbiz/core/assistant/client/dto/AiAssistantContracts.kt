package ai.govbiz.core.assistant.client.dto

/** AI Service `POST /internal/v1/assistant/answers` 요청입니다. 필드 이름과 상한은 AI Service `app/assistant/models.py`와 같습니다. */
data class AiAssistantAnswerRequest(
    val schemaVersion: String,
    val message: String,
    val history: List<AiAssistantHistoryMessage>,
    val session: AiAssistantSession,
    val context: AiAssistantContext,
    val helpEntries: List<AiAssistantHelpEntry>,
)

data class AiAssistantHistoryMessage(
    val role: String,
    val content: String,
)

data class AiAssistantSession(
    val authenticated: Boolean,
    val hasCompany: Boolean,
)

data class AiAssistantContext(
    val route: String,
    val programSelected: Boolean,
)

data class AiAssistantHelpEntry(
    val id: String,
    val title: String,
    val question: String,
    val summary: String,
    val body: List<String>,
    val limitation: String?,
    val audience: String,
    val status: String,
    val action: AiAssistantHelpAction?,
)

data class AiAssistantHelpAction(
    val label: String,
    val to: String,
)

/** AI Service 응답입니다. 의도별 필드 조합은 Core Service가 다시 검증합니다. */
data class AiAssistantAnswerPayload(
    val schemaVersion: String?,
    val intent: String?,
    val answer: String?,
    val citations: List<String?>?,
    val clarificationQuestion: String?,
    val searchQuery: String?,
    val accountTopic: String?,
)

/**
 * AI Service `POST /internal/v1/assistant/agent` 요청입니다. `answers` 본문에 도구가 Core를 되부를 때 쓰는 계정 묶음
 * 토큰(`principal`)을 더합니다. 비로그인은 `principal`이 null이고 AI Service는 도구 경로를 막습니다.
 * 필드 이름은 AI Service `app/assistant_agent/models.py`와 같습니다.
 */
data class AiAssistantAgentRequest(
    val schemaVersion: String,
    val message: String,
    val history: List<AiAssistantHistoryMessage>,
    val session: AiAssistantSession,
    val context: AiAssistantContext,
    val helpEntries: List<AiAssistantHelpEntry>,
    val principal: AiAssistantPrincipal?,
    /** 관심 공고 묶음 질문의 두 번째 호출에만 싣습니다. 최대 10건, 공고당 청크 최대 50개입니다. */
    val savedProgramDocuments: List<AiAssistantSavedProgramDocument>? = null,
    /** 두 번째 호출에서 분류를 건너뛰고 이어갈 의도입니다. */
    val resumeIntent: String? = null,
)

data class AiAssistantSavedProgramDocument(
    val sourceCode: String,
    val sourceProgramId: String,
    val title: String,
    val applicationEndDate: String?,
    val documentId: String,
    /** 비어 있으면 원문을 확보하지 못한 공고입니다. */
    val chunks: List<AiAssistantChunkRef>,
)

data class AiAssistantChunkRef(
    val id: String,
    val contentHash: String,
)

data class AiAssistantPrincipal(
    val accountId: Long,
    val toolToken: String,
    val hasCompany: Boolean,
)

/** 에이전트 응답입니다. 카드·이동 경로는 Core가 허용 목록과 형식으로 다시 검증합니다. */
data class AiAssistantAgentPayload(
    val schemaVersion: String?,
    val intent: String?,
    val answer: String?,
    val citations: List<String?>?,
    val clarificationQuestion: String?,
    val searchQuery: String?,
    val accountTopic: String?,
    val cards: List<AiAssistantCardPayload?>?,
    val navigation: AiAssistantNavigationPayload?,
    val toolCalls: List<AiAssistantToolCallPayload?>?,
    /** 관심 공고 묶음 질문인데 청크 허용 목록이 없어 Core가 원문을 준비해 다시 불러야 할 때 true입니다. */
    val needsDocuments: Boolean?,
)

data class AiAssistantCardPayload(
    val kind: String?,
    val id: String?,
    val title: String?,
    val subtitle: String?,
    val reason: String?,
    val quote: String?,
    val to: String?,
)

data class AiAssistantNavigationPayload(
    val label: String?,
    val to: String?,
)

data class AiAssistantToolCallPayload(
    val name: String?,
    val ms: Int?,
    val ok: Boolean?,
)
