function classes(...groups: string[]) {
  return groups.join(' ')
}

/**
 * 공고 상세의 배치입니다. 웹 화면 v2의 공고 상세 보드를 따릅니다.
 * 넓은 화면은 본문 열과 320px 할 일 카드가 두 열이고, 좁은 화면(600px 미만)은 흰 바탕 한 열에 위 앱 바(뒤로·공고 상세)와
 * 아래 고정 동작 바(관심 공고·더 보기·원문에 질문하기)가 붙습니다.
 */
export const supportProgramDetailStyles = {
  page: 'mx-auto w-full max-w-[1240px] px-6 pt-5 pb-12 text-app-ink [overflow-wrap:anywhere] max-[1023px]:px-5 max-[599px]:bg-surface max-[599px]:px-0 max-[599px]:pt-0 max-[599px]:pb-36',
  // 맨 위 줄입니다. 모든 폭에서 모바일 앱 바 모양("‹ 공고 상세")이고 좁은 화면만 아래 선이 붙습니다.
  topBar: 'flex h-14 flex-wrap items-center gap-1 max-[599px]:border-b max-[599px]:border-line max-[599px]:px-1',
  // "‹ 공고 상세" 전체가 하나의 링크입니다. 배경 없이 글자만 두고, 올리면 초록으로 바뀝니다.
  backLink: classes(
    'inline-flex h-11 items-center gap-1 rounded-xl px-1.5 text-[1.0625rem] font-semibold text-app-ink no-underline',
    'hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  // 빼기 확인입니다. 본문 위에 한 줄로 둡니다.
  removeConfirm: 'mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-warning-line bg-warning-soft px-4 py-3 text-[0.85rem] text-app-ink max-[599px]:mx-5',
  layout: 'mt-3.5 grid grid-cols-[minmax(0,1fr)_300px] items-start gap-7 max-[1023px]:grid-cols-1 max-[1023px]:gap-6 max-[599px]:mt-0 max-[599px]:px-5 max-[599px]:pt-5',
  article: 'flex min-w-0 flex-col gap-6 max-[599px]:gap-[18px]',
  // 요약 hero 카드입니다. 상태·D-day·출처, 제목, 기관.
  heading: 'flex flex-col gap-2 rounded-2xl border border-line bg-surface px-6 py-5 max-[599px]:px-4 max-[599px]:py-4',
  meta: 'flex flex-wrap items-center gap-2.5 max-[599px]:gap-2',
  status: 'inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold',
  statusOpen: 'text-brand-primary',
  statusUpcoming: 'text-info',
  statusClosed: 'text-ink-muted',
  statusUnknown: 'text-ink-muted',
  statusDot: 'size-[7px] rounded-full',
  statusDotOpen: 'bg-brand-primary',
  statusDotUpcoming: 'bg-info',
  statusDotClosed: 'bg-line-strong',
  statusDotUnknown: 'border-[1.5px] border-ink-subtle',
  deadline: 'rounded-md px-[7px] py-[3px] text-[0.75rem] font-bold tabular-nums',
  deadlineUrgent: 'bg-warning-soft text-warning',
  deadlineCalm: 'bg-surface-muted text-ink-muted',
  source: 'text-[0.8125rem] text-ink-subtle',
  title: 'm-0 text-[1.75rem] font-bold leading-[1.35] tracking-[-0.02em] text-app-ink max-[599px]:text-[1.375rem] max-[599px]:leading-[1.4]',
  organization: 'm-0 text-[0.9375rem] text-ink-muted',
  summary: 'm-0 max-w-[620px] text-[1rem] leading-[1.75] text-app-ink max-[599px]:max-w-none max-[599px]:leading-[1.7]',
  // 한눈에 보기입니다. 넓은 화면은 흰 카드에 두 열 정의 목록, 좁은 화면은 연한 바탕에 한 열입니다.
  glance: 'rounded-2xl border border-line bg-surface px-6 pt-1.5 pb-2 max-[599px]:px-4 max-[599px]:pt-1',
  // 공고 내용 카드입니다. 지원 내용 · 지원 대상 절과 자격 미평가 안내.
  prose: 'flex flex-col gap-5 rounded-2xl border border-line bg-surface px-6 py-5 max-[599px]:gap-4 max-[599px]:px-4 max-[599px]:py-4',
  proseSection: 'flex flex-col gap-1.5',
  proseTitle: 'm-0 text-[0.9375rem] font-semibold text-app-ink',
  glanceTitle: 'mt-3.5 mb-1.5 text-[0.9375rem] font-semibold text-app-ink max-[599px]:mt-3 max-[599px]:mb-1',
  glanceList: 'm-0',
  glanceRow: 'grid grid-cols-[112px_minmax(0,1fr)] gap-4 border-t border-surface-muted py-3.5 max-[599px]:grid-cols-1 max-[599px]:gap-1 max-[599px]:border-line max-[599px]:py-3',
  glanceRowTight: 'items-center py-3',
  glanceLabel: 'text-[0.875rem] text-ink-subtle max-[599px]:text-[0.8125rem]',
  glanceValue: 'm-0 text-[0.9375rem] leading-[1.6] text-app-ink',
  glanceValueStrong: 'font-medium tabular-nums',
  glanceValueMuted: 'text-ink-muted',
  // 문의처의 전화번호입니다. 눌러서 전화 앱으로 겁니다.
  contactLink: 'font-medium text-brand-primary underline underline-offset-2 hover:text-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  tagList: 'm-0 flex list-none flex-wrap gap-1.5 p-0',
  tag: 'rounded-md bg-surface-muted px-[9px] py-1 text-[0.8125rem] font-medium text-ink-muted',
  emptyValue: 'text-ink-muted',
  note: 'm-0 flex items-start gap-2.5 text-[0.8125rem] leading-[1.6] text-ink-muted',
  notePill: 'shrink-0 rounded-full bg-surface-muted px-[9px] py-0.5 text-[0.75rem] font-semibold text-ink-muted',
  // 할 일 카드입니다. 넓은 화면은 오른쪽 흰 카드, 좁은 화면은 아래 고정 동작 바가 되고 나머지 줄은 [더 보기]로 펼칩니다.
  aside: classes(
    'flex flex-col gap-4 rounded-2xl bg-surface p-5',
    'max-[599px]:fixed max-[599px]:inset-x-0 max-[599px]:bottom-0 max-[599px]:z-10 max-[599px]:gap-3 max-[599px]:rounded-none max-[599px]:border-t max-[599px]:border-line max-[599px]:px-4 max-[599px]:pt-3 max-[599px]:pb-[calc(1.75rem+env(safe-area-inset-bottom))]',
  ),
  // 좁은 화면의 동작 바 한 줄입니다. 넓은 화면에서는 세로로 풀립니다.
  asideBar: 'contents max-[599px]:flex max-[599px]:items-center max-[599px]:gap-2',
  primaryAction: classes(
    'inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full border-0 bg-brand-primary px-5 text-[0.9375rem] font-semibold text-white no-underline',
    'hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'max-[599px]:order-last max-[599px]:h-[52px] max-[599px]:w-auto max-[599px]:flex-1 max-[599px]:text-base',
  ),
  primaryHint: 'm-0 text-center text-[0.75rem] leading-[1.55] text-ink-subtle max-[599px]:hidden',
  divider: 'h-px bg-surface-muted max-[599px]:hidden',
  moreButton: classes(
    'hidden h-[52px] shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-surface px-[18px] text-base font-semibold text-app-ink',
    'max-[599px]:inline-flex focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  // [더 보기]로 펼치는 줄들입니다. 넓은 화면에서는 항상 보입니다.
  more: '-mx-2 -my-1 flex flex-col gap-0.5 max-[599px]:m-0 max-[599px]:border-b max-[599px]:border-line max-[599px]:pb-3',
  moreHidden: 'max-[599px]:hidden',
  row: classes(
    'flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-[10px] border-0 bg-transparent px-2 text-left text-[0.875rem] font-medium text-app-ink no-underline',
    'hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-60',
  ),
  rowIcon: 'shrink-0 text-ink-muted',
  rowIconActive: 'shrink-0 text-brand-primary',
  rowLabel: 'flex-1',
  // 관심 공고 담기는 [원문에 질문하기] 아래 테두리 알약입니다. 담기면 연한 초록으로 채워지고, 좁은 화면은 동작 바의 동그라미 하나가 됩니다.
  saveButton: classes(
    'inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[0.875rem] font-semibold text-app-ink no-underline',
    'hover:border-brand-primary hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-60',
    'aria-pressed:border-brand-line aria-pressed:bg-brand-soft aria-pressed:text-brand-primary',
    'max-[599px]:order-first max-[599px]:size-[52px] max-[599px]:w-[52px] max-[599px]:shrink-0 max-[599px]:gap-0 max-[599px]:border-0 max-[599px]:bg-surface-muted max-[599px]:p-0',
  ),
  saveIcon: 'shrink-0',
  saveLabel: 'max-[599px]:sr-only',
  sourceBlock: 'flex flex-col gap-2.5',
  sourceNote: 'm-0 text-[0.8125rem] leading-[1.6] text-ink-muted',
  sourceNoteLead: 'font-semibold text-app-ink',
  sourceLink: classes(
    'inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-4 text-[0.875rem] font-semibold text-app-ink no-underline',
    'hover:border-brand-primary hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  // 불러오는 동안의 스켈레톤입니다. 완성 화면과 같은 카드 자리(hero · 한눈에 보기 · 공고 내용 · 할 일)를 잡아 둡니다.
  skeletonCard: 'flex flex-col gap-3 rounded-2xl border border-line bg-surface px-6 py-5 max-[599px]:px-4 max-[599px]:py-4',
  skeletonBar: 'h-3.5 rounded-md bg-surface-muted motion-safe:animate-pulse',
  skeletonBarTall: 'h-11 rounded-full bg-surface-muted motion-safe:animate-pulse',
  // 없음·실패 상태입니다. 할 일 열 없이 1열이라 카드가 본문 전체 폭을 쓰고, 여백은 상세 2열 배치와 같습니다.
  stateLayout: 'mt-3.5 max-[599px]:mt-0 max-[599px]:px-5 max-[599px]:pt-5',
  // 점선 카드 안에 원 표지 + 제목 + 설명 + 동작을 가운데 정렬합니다(빈·오류 상태 규칙).
  stateCard: 'flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface px-5 py-9 text-center max-[599px]:px-4 max-[599px]:py-7',
  stateGlyph: 'grid size-11 place-items-center rounded-full bg-surface-muted text-ink-muted',
  stateGlyphDanger: 'bg-danger-soft text-danger',
  stateTitle: 'm-0 text-[0.9375rem] font-bold text-app-ink',
  stateDescription: 'm-0 max-w-[36ch] text-[0.8125rem] leading-[1.6] text-ink-muted',
  retryButton: 'mt-2 inline-flex h-10 cursor-pointer items-center rounded-full border-0 bg-brand-primary px-4 text-[0.84375rem] font-bold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
} as const
