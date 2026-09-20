package ai.govbiz.core.assistant.domain

/**
 * AI Service가 고른 의도입니다. Core는 의도별로 무엇을 조회하고 어디로 안내할지 정합니다.
 * `PARTNER_MATCH`·`SAVED_PROGRAMS_QUESTION`은 도구 에이전트 경로(`app.assistant.agent-enabled`)에서만 나옵니다.
 */
enum class AssistantIntent {
    PRODUCT_HELP,
    ACCOUNT_STATE,
    SEARCH,
    PROGRAM_QUESTION,
    OUT_OF_SCOPE,
    UNCLEAR,
    PARTNER_MATCH,
    SAVED_PROGRAMS_QUESTION,
    ;

    /** 회원 자료를 도구로 읽어 답하는 의도입니다. 비로그인이면 로그인 안내로 끝납니다. */
    val usesTools: Boolean
        get() = this == ACCOUNT_STATE || this == PARTNER_MATCH || this == SAVED_PROGRAMS_QUESTION
}

/** 계정 상태 질문의 영역입니다. Core가 회원 자료를 읽어 답을 만드는 기준입니다. */
enum class AssistantAccountTopic {
    SAVED_PROGRAMS,
    RECEIVED_PROPOSALS,
    COMPANY_PROFILE,
}

/** 답변 뒤에 붙는 이동 버튼입니다. `to`는 Core가 허용한 내부 경로만 담습니다. */
data class AssistantNavigation(
    val label: String,
    val to: String,
)

enum class AssistantCardKind {
    RECRUITMENT,
    PROGRAM,
}

/**
 * 도구 에이전트가 고른 항목 하나입니다. 모집글은 `id`가 모집글 번호, 공고는 `sourceCode:sourceProgramId`입니다.
 * 제목·부제·경로는 AI Service가 도구 결과에서 채우고 Core가 형식과 경로를 다시 검사합니다.
 */
data class AssistantCard(
    val kind: AssistantCardKind,
    val id: String,
    val title: String,
    val subtitle: String?,
    val reason: String,
    val to: String,
    /** 관심 공고 묶음 질문에서만: 근거 청크 원문에서 글자 그대로 옮긴 구절입니다. Core가 청크와 대조해 통과한 것만 남깁니다. */
    val quote: String? = null,
)

/** 프런트 말풍선 하나에 해당하는 답입니다. 의도에 따라 채워지는 필드가 다릅니다. */
data class AssistantAnswer(
    val intent: AssistantIntent,
    /** 본문입니다. UNCLEAR만 null입니다. */
    val answer: String?,
    /** 답의 근거가 된 도움말 항목 id입니다. 요청에 실린 항목만 남깁니다. */
    val citations: List<String>,
    val clarificationQuestion: String?,
    val searchQuery: String?,
    val accountTopic: AssistantAccountTopic?,
    val navigation: AssistantNavigation?,
    /** 도구 에이전트가 고른 항목입니다. 도구 의도의 답에만 붙고 최대 5장입니다. */
    val cards: List<AssistantCard> = emptyList(),
)

/** 도우미가 요청과 함께 받은 도움말 한 항목입니다. 프런트 `helpContent.ts`가 원본이며 Core는 사본을 두지 않습니다. */
data class AssistantHelpEntry(
    val id: String,
    val title: String,
    val question: String,
    val summary: String,
    val body: List<String>,
    val limitation: String?,
    val audience: String,
    val status: String,
    val action: AssistantNavigation?,
)

data class AssistantHistoryMessage(
    val role: AssistantHistoryRole,
    val content: String,
)

enum class AssistantHistoryRole {
    USER,
    ASSISTANT,
}

/** 사용자가 지금 보고 있는 화면입니다. `programSelected`는 공고 상세처럼 원문 질문을 열 수 있는 화면인지입니다. */
data class AssistantScreenContext(
    val route: String,
    val programSelected: Boolean,
)

data class AssistantQuestion(
    val message: String,
    val history: List<AssistantHistoryMessage>,
    val context: AssistantScreenContext,
    val helpEntries: List<AssistantHelpEntry>,
)
