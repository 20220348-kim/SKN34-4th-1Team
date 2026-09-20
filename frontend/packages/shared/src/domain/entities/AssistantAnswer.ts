/**
 * Core가 AI Service 분류를 검증해 돌려준 도우미 의도입니다. 화면은 이 값으로 말풍선 모양을 정합니다.
 * `PARTNER_MATCH`·`SAVED_PROGRAMS_QUESTION`은 Core의 도구 에이전트가 켜져 있을 때만 옵니다.
 */
export type AssistantIntent =
  | 'PRODUCT_HELP' | 'ACCOUNT_STATE' | 'SEARCH' | 'PROGRAM_QUESTION' | 'OUT_OF_SCOPE' | 'UNCLEAR'
  | 'PARTNER_MATCH' | 'SAVED_PROGRAMS_QUESTION'

export type AssistantAccountTopic = 'SAVED_PROGRAMS' | 'RECEIVED_PROPOSALS' | 'COMPANY_PROFILE'

/** 답 뒤에 붙는 이동 버튼 하나입니다. `to`는 Core가 허용한 `/app` 아래 경로입니다. */
export type AssistantNavigation = {
  label: string
  to: string
}

export type AssistantCardKind = 'RECRUITMENT' | 'PROGRAM'

/** 도구 에이전트가 회원 자료에서 고른 항목 하나입니다. 제목을 누르면 `to`의 상세 화면으로 갑니다. */
export type AssistantCard = {
  kind: AssistantCardKind
  /** 모집글은 모집글 번호, 공고는 `sourceCode:sourceProgramId`입니다. */
  id: string
  title: string
  subtitle: string | null
  /** 이 항목을 고른 이유 한 문장입니다. */
  reason: string
  /** 관심 공고 묶음 질문에서만: 공고 원문에서 그대로 옮긴 근거 구절입니다. Core가 원문과 대조한 것만 옵니다. */
  quote: string | null
  to: string
}

/** 도우미 자유 질문 한 건의 답입니다. 의도에 따라 채워지는 필드가 다르고, `UNCLEAR`만 `answer`가 없습니다. */
export type AssistantAnswer = {
  intent: AssistantIntent
  answer: string | null
  /** 근거가 된 도움말 항목 id입니다. 요청에 실어 보낸 항목만 옵니다. */
  citations: string[]
  clarificationQuestion: string | null
  searchQuery: string | null
  accountTopic: AssistantAccountTopic | null
  navigation: AssistantNavigation | null
  /** 도구 의도의 답에만 붙는 항목 목록(최대 5장)입니다. 그 밖에는 빈 배열입니다. */
  cards: AssistantCard[]
}
