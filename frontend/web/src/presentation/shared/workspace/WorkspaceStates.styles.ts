import type { DdayTone } from '@govbiz/shared/domain/labels'

function classes(...groups: string[]) {
  return groups.join(' ')
}

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'

/**
 * 작업 화면이 함께 쓰는 상태 조각(EmptyState · ErrorState · StatusTag)의 모양입니다. 색은 의미 토큰만 씁니다.
 * 빈 화면은 `/app/application-preparations/new`의 빈 칸, 태그는 기준 목록 화면(`/app/combination-reviews`)의 배지를 따릅니다.
 */
export const workspaceStateStyles = {
  // 빈 화면: 점선 테두리 카드 가운데에 둥근 아이콘 · 제목 · 한 줄 설명 · 다음 행동 버튼 하나. 점선은 빈 화면에만 씁니다.
  // 아이콘은 맞춤 리포트 빈 화면처럼 회색 원에 선 아이콘으로 두고, 색은 다음 행동 버튼(초록)에만 씁니다.
  empty: 'flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong bg-surface px-5 py-8 text-center',
  emptyIcon: 'grid size-11 place-items-center rounded-full bg-surface-muted text-ink-muted',
  emptyTitle: 'm-0 text-[0.9375rem] font-bold text-ink',
  emptyDescription: 'm-0 max-w-[36rem] text-[0.8125rem] leading-[1.6] text-ink-muted',
  // 누를 수 있는 요소는 44px 이상입니다.
  emptyAction: classes(
    'inline-flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-full border-0 bg-brand-primary px-5',
    'text-[0.8125rem] font-bold text-white no-underline hover:bg-brand-hover',
    'disabled:cursor-not-allowed disabled:opacity-60',
    focus,
  ),
  // 오류: 연한 danger 바탕에 한 문장과 [다시 시도] 하나.
  error: 'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-danger-line bg-danger-soft px-4 py-3',
  errorMessage: 'm-0 min-w-0 flex-1 text-[0.8125rem] leading-[1.6] text-ink',
  errorRetry: classes(
    'inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line-strong bg-surface px-4',
    'text-[0.8125rem] font-bold text-ink hover:border-brand-primary hover:text-brand-primary',
    'disabled:cursor-not-allowed disabled:opacity-50',
    focus,
  ),
  // 상태 태그: 22px 배지. 점과 글자를 함께 두어 색만으로 상태를 나누지 않습니다.
  tagRow: 'inline-flex flex-wrap items-center gap-1.5',
  tag: 'inline-flex h-[22px] items-center gap-1 rounded-md px-[7px] text-[0.72rem] font-bold whitespace-nowrap',
  tagDot: 'size-1.5 rounded-full bg-current',
  tagBrand: 'bg-brand-soft text-brand-primary',
  tagInfo: 'bg-info-soft text-info',
  tagNeutral: 'bg-surface-muted text-ink-muted',
  tagWarning: 'bg-warning-soft text-warning',
} as const

/**
 * D-day 배지의 색입니다. shared `ddayTone`의 단계(7일 이내 빨강 · 30일 이내 노랑 · 그 뒤 초록 · 지남 회색)를 모든 작업 화면이 같은 색으로 씁니다.
 * 모양(높이 · 모서리 · 여백)은 화면마다 다르므로 색 클래스만 둡니다.
 */
export const ddayToneClassNames: Record<DdayTone, string> = {
  urgent: 'bg-danger-soft text-danger',
  soon: 'bg-warning-soft text-warning',
  later: 'bg-brand-soft text-brand-primary',
  closed: 'bg-surface-muted text-ink-muted',
}
