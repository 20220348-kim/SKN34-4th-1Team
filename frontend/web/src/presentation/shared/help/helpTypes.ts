/**
 * 도움말 항목의 계약입니다. 기능 가이드·FAQ·서비스 매뉴얼·도움말 챗봇이 모두 이 한 벌을 읽습니다.
 * 표면마다 따로 문구를 두면 서로 어긋나므로, 같은 항목을 `surfaces`로 나눠 씁니다.
 */

/** 항목이 노출되는 표면입니다. `guide`는 화면 안 팝오버, `manual`은 /help 본문입니다. */
export type HelpSurface = 'guide' | 'faq' | 'manual' | 'chatbot'

/** 항목을 이해하는 데 필요한 최소 자격입니다. 화면 접근 권한이 아니라 내용의 대상입니다. */
export type HelpAudience = 'public' | 'member' | 'company' | 'admin'

/** 설명하는 기능의 현재 상태입니다. 준비 중을 정식처럼 안내하지 않기 위해 필수입니다. */
export type HelpStatus = 'available' | 'demo' | 'planned'

/**
 * 항목의 성격입니다.
 * - `blocker`: 설명이 없으면 오해하는 동작. 도움말의 최우선 대상입니다.
 * - `screen`: 화면 하나의 사용법.
 * - `error`: 사용자에게 보이는 오류 문구의 대응 안내.
 * - `policy`: 요금·범위처럼 기능이 아닌 정책.
 */
export type HelpCategory = 'blocker' | 'screen' | 'error' | 'policy'

/**
 * 항목을 읽은 다음 갈 곳입니다. 설명만 하고 끝내지 않기 위해 둡니다.
 * `to`는 `/app` 아래 경로이며 파라미터 없이 열 수 있는 경로만 씁니다.
 * 공개 화면에서는 `helpActionHref`가 대응하는 공개 경로로 바꿉니다.
 */
export type HelpAction = {
  label: string
  to: string
}

export type HelpEntry = {
  /** 인용·링크에 쓰는 고정 식별자입니다. 한 번 정하면 바꾸지 않습니다. */
  id: string
  /** 매뉴얼 제목과 FAQ 목록에 쓰는 표시 이름입니다. */
  title: string
  /** 챗봇 추천 버튼에 그대로 넣는 질문 문구입니다. 사용자가 실제로 쓸 말로 적습니다. */
  question: string
  /** 결론 한두 문장입니다. 가이드 팝오버와 챗봇 답변의 첫 문장이 됩니다. */
  summary: string
  /** 매뉴얼 본문입니다. 한 항목이 한 문단이며 마크다운을 쓰지 않습니다. */
  body: readonly string[]
  /** 지금 안 되는 것입니다. 없으면 `null`이며, 있으면 화면에 반드시 함께 표시합니다. */
  limitation: string | null
  category: HelpCategory
  surfaces: readonly HelpSurface[]
  audience: HelpAudience
  /**
   * 이 설명이 필요한 화면들입니다. `/app` 아래 경로를 쓰며 하위 경로도 함께 걸립니다.
   * 비우면 화면과 무관한 항목이 되어 어느 화면에서나 추천 후보가 됩니다.
   */
  routes: readonly string[]
  action: HelpAction | null
  status: HelpStatus
  /** 함께 읽을 항목의 `id`입니다. 실제로 있는 항목만 적습니다. */
  related: readonly string[]
  /** 내용을 마지막으로 손본 날짜입니다. 화면에 표시해 오래된 안내를 드러냅니다. */
  updatedOn: string
}
