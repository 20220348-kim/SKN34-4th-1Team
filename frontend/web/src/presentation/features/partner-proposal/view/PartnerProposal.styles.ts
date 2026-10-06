function classes(...groups: string[]) {
  return groups.join(' ')
}

// 색상이나 CSS 속성이 아니라 제안함 화면에서 맡는 UI 역할을 이름으로 사용합니다.
// 화면 통일안 34: 머리글 오른쪽 세그먼트(받은 · 보낸) → 상태 칩 → 행 목록 → 행을 누르면 옆 패널(모바일 아래 시트).
export const partnerProposalStyles = {
  lede: 'm-0 -mt-2 text-[0.8125rem] leading-[1.6] text-ink-muted',
  statusChips: 'flex flex-wrap items-center gap-2',
  chipCount: 'ml-1 tabular-nums opacity-80',
  // 기업 미등록 안내는 카드가 아니라 한 줄 info Alert입니다.
  infoAlert: 'flex flex-wrap items-center justify-between gap-3 rounded-[0.85rem] border border-info-line bg-info-soft px-4 py-3 text-[0.8125rem] leading-[1.55] text-ink',
  list: 'flex flex-col overflow-hidden rounded-[1.4rem] border border-line bg-white',
  row: classes(
    'flex w-full cursor-pointer items-center gap-3 border-0 border-b border-line bg-white px-4 py-3 text-left last:border-b-0',
    'hover:bg-[#f6f7f8] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-primary',
    'aria-[current=true]:bg-brand-soft',
  ),
  rowAvatar: 'grid size-9 shrink-0 place-items-center rounded-[0.6rem] bg-brand-primary text-[0.85rem] font-extrabold text-white',
  rowBody: 'flex min-w-0 flex-1 flex-col gap-0.5',
  rowTitle: 'flex flex-wrap items-center gap-2 text-[0.875rem] font-bold text-ink',
  rowSub: 'flex min-w-0 text-[0.75rem] text-ink-muted [&>span:first-child]:truncate',
  rowDue: 'hidden shrink-0 text-[0.75rem] font-bold whitespace-nowrap text-ink-muted tabular-nums min-[600px]:block',
  rowChevron: 'shrink-0 text-ink-muted',
  statusBadge: 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.68rem] font-extrabold whitespace-nowrap',
  statusDot: 'size-1.5 rounded-full bg-current',
  // 옆 패널입니다. 넓은 화면은 오른쪽 400px, 좁은 화면(600px 미만)은 아래 시트(최대 86%).
  panel: classes(
    'fixed inset-y-0 right-0 z-20 flex w-[400px] max-w-full flex-col border-l border-line bg-surface shadow-[-18px_0_40px_rgb(32_33_36_/_12%)]',
    'max-[599px]:inset-x-0 max-[599px]:top-auto max-[599px]:bottom-0 max-[599px]:w-auto max-[599px]:max-h-[86dvh] max-[599px]:rounded-t-[22px] max-[599px]:border-0 max-[599px]:shadow-[0_-12px_32px_rgb(32_33_36_/_12%)]',
  ),
  panelScrim: 'hidden max-[599px]:block max-[599px]:fixed max-[599px]:inset-0 max-[599px]:z-[19] max-[599px]:cursor-default max-[599px]:border-0 max-[599px]:bg-black/35 max-[599px]:p-0',
  panelHeader: 'relative flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 pt-4 pb-3 max-[599px]:pt-5',
  panelGrab: 'hidden max-[599px]:block max-[599px]:absolute max-[599px]:top-2 max-[599px]:left-1/2 max-[599px]:h-1 max-[599px]:w-9 max-[599px]:-translate-x-1/2 max-[599px]:rounded-full max-[599px]:bg-line-strong',
  panelHeading: 'flex min-w-0 flex-col gap-0.5',
  panelTitle: 'm-0 text-[1rem] font-bold text-ink',
  panelSubtitle: 'm-0 truncate text-[0.8125rem] text-ink-muted',
  panelClose: 'grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  panelBody: 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4',
  panelFooter: 'flex shrink-0 items-center gap-2 border-t border-line px-5 py-3 max-[599px]:pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
  counterpartRow: 'flex items-center gap-3',
  counterpartAvatar: 'grid size-10 shrink-0 place-items-center rounded-[0.65rem] bg-brand-primary text-[0.95rem] font-extrabold text-white',
  counterpartName: 'block text-[0.95rem] font-bold text-ink',
  counterpartSummary: 'mt-0.5 block text-[0.78rem] text-ink-muted',
  tagRow: 'flex flex-wrap gap-1.5',
  kv: 'm-0 flex flex-col gap-2 text-[0.8125rem]',
  kvRow: 'flex items-baseline gap-4',
  kvLabel: 'w-16 shrink-0 text-ink-muted',
  kvValue: 'm-0 min-w-0 flex-1 text-ink tabular-nums [overflow-wrap:anywhere]',
  recruitmentLink: 'font-bold text-brand-primary no-underline hover:underline',
  messageLabel: 'mb-1.5 block text-[0.78rem] font-bold text-ink',
  message: 'm-0 whitespace-pre-line rounded-[0.85rem] border border-line bg-[#f8faf9] px-4 py-3 text-[0.85rem] leading-[1.7] text-ink',
  noteAlert: 'flex flex-col gap-0.5 rounded-[0.85rem] border border-info-line bg-info-soft px-4 py-3 text-[0.8rem] leading-[1.55] text-ink',
  noteTitle: 'font-bold',
  contactCard: 'flex flex-col gap-1 rounded-[0.85rem] bg-brand-soft px-4 py-3 text-[0.82rem] text-ink',
  contactLabel: 'text-[0.7rem] font-extrabold tracking-[0.06em] text-brand-primary uppercase',
  contactLink: 'font-bold text-brand-primary no-underline hover:underline [overflow-wrap:anywhere]',
  // 바닥 버튼: 거절·철회는 되돌릴 수 없어 위험 테두리, 수락은 primary로 남은 폭을 채웁니다.
  dangerOutlineButton: classes(
    'inline-flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-danger-line bg-white px-5 text-[0.9375rem] font-semibold text-danger',
    'hover:bg-danger-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger disabled:cursor-not-allowed disabled:opacity-60 max-[599px]:flex-1',
  ),
  primaryButton: classes(
    'inline-flex h-11 flex-1 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary px-5 text-[0.9375rem] font-semibold text-white',
    'hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-60 max-[599px]:flex-[2]',
  ),
  notice: 'flex items-center justify-between gap-3 rounded-[0.85rem] border border-warning-line bg-warning-soft px-4 py-3 text-[0.8125rem] text-ink',
  emptyCard: 'flex flex-col items-start gap-3 rounded-[1.4rem] border border-line bg-white p-6',
  skeletonRow: 'flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0',
  skeletonBar: 'h-3.5 rounded-md bg-surface-muted motion-safe:animate-pulse',
} as const

/** 상태 배지의 색입니다. 응답 대기 info · 수락 brand · 거절 · 철회 neutral · 만료 warning. */
export const proposalStatusBadgeClassName: Record<'info' | 'ok' | 'muted' | 'warn', string> = {
  info: 'bg-info-soft text-info',
  ok: 'bg-brand-soft text-brand-primary',
  muted: 'bg-surface-muted text-ink-muted',
  warn: 'bg-warning-soft text-warning',
}
