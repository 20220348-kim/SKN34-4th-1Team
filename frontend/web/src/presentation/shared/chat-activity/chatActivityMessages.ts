import type { ChatActivity, ChatOutcome } from '../../features/chat/state/chatSlice'

/** 검색 화면 밖에서 진행 상태와 결과 도착을 알리는 문구입니다. */
export const chatActivityMessages = {
  headerSearching: '검색 진행 중',
  headerInterpreting: '조건 해석 진행 중',
  headerUnseen: '검색 결과 도착',
  open: '대화 보기',
  close: '닫기',
  toastLabel: '검색 알림',
  openHistoryTitle: '검색이 진행 중입니다',
  openHistoryDescription: '다른 대화를 열면 진행 중인 검색이 취소되고 결과를 받지 못합니다. 계속할까요?',
  newChatDescription: '새 검색을 시작하면 진행 중인 검색이 취소되고 결과를 받지 못합니다. 계속할까요?',
  openHistoryContinue: '계속',
  openHistoryCancel: '취소',
} as const

/**
 * 조건 해석은 몇 초 안에 끝나므로 헤더 칩은 진행 중 표시 없이 결과가 도착했을 때만 알립니다.
 * 검색은 수십 초가 걸려 진행 중임을 계속 보여 주고, 대화 기록 항목의 점은 해석 중에도 붙입니다.
 */
export function visibleChatActivity(activity: ChatActivity | null): ChatActivity | null {
  return activity?.kind === 'interpreting' ? null : activity
}

/** 토스트를 띄우지 않는 결과입니다. "답변이 도착했어요"는 요청에 따라 알림을 끄고, 배지로만 알립니다. */
export const silentToastOutcomes: ReadonlySet<ChatOutcome> = new Set<ChatOutcome>(['interpretation-answered'])

export function chatOutcomeMessage(outcome: ChatOutcome, resultCount: number | null): string {
  switch (outcome) {
    case 'search-succeeded':
      return resultCount === null ? '지원사업 검색이 끝났어요.' : `지원사업 검색이 끝났어요. 결과 ${resultCount}건이에요.`
    case 'search-failed':
      return '지원사업 검색을 마치지 못했어요. 대화에서 다시 시도할 수 있어요.'
    case 'interpretation-ready':
      return '조건 변경안이 준비됐어요. 확인을 눌러야 검색이 시작돼요.'
    case 'interpretation-clarification':
      return '조건을 확인하는 질문이 있어요. 답하면 검색을 이어가요.'
    case 'interpretation-answered':
      // 토스트는 `silentToastOutcomes`로 꺼 두었고, 문구는 스크린 리더 안내용으로 남깁니다.
      return '답변이 도착했어요.'
    case 'interpretation-failed':
      return '조건 해석을 마치지 못했어요. 대화에서 다시 시도할 수 있어요.'
  }
}

/** 점 표시의 상태입니다. 진행 중이면 깜박이고, 실패는 붉은색, 나머지 도착은 초록 점입니다. */
export function chatActivityTone(activity: ChatActivity): 'pending' | 'done' | 'failed' {
  if (activity.kind !== 'unseen') return 'pending'
  return activity.outcome === 'search-failed' || activity.outcome === 'interpretation-failed' ? 'failed' : 'done'
}

export function chatActivityHeaderLabel(activity: ChatActivity | null): string | null {
  const visible = visibleChatActivity(activity)
  if (visible === null) return null
  if (visible.kind === 'searching') return chatActivityMessages.headerSearching
  if (visible.kind === 'interpreting') return chatActivityMessages.headerInterpreting
  return chatActivityMessages.headerUnseen
}
