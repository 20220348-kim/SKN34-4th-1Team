function classes(...groups: string[]) {
  return groups.join(' ')
}

// 색상이나 CSS 속성이 아니라 관리자 계정 목록·상세에서 맡는 UI 역할을 이름으로 사용합니다.
// 카드·표·태그·버튼은 shared/workspace의 공용 스타일을 쓰고 여기서는 계정 화면 고유 배치만 다룹니다.
export const adminAccountsPageStyles = {
  // 폭이 좁아져도 칸 하나만 다음 줄에 남지 않도록 같은 폭 격자로 줄어듭니다.
  statRow: 'grid gap-3 grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))]',
  statCell:
    'flex min-w-0 flex-col gap-[0.2rem] rounded-[1.4rem] border border-sample-border bg-white px-4 py-[0.85rem]',
  statValue: 'text-[1.35rem] font-bold tracking-[-0.03em]',
  statLabel: 'text-[0.7rem] text-sample-muted',
  // 공개 파트너 모집·지원사업 찾기와 같은 검색 칸·"검색 결과 N건"·선택 상자 모양입니다.
  searchRow: 'flex flex-wrap items-center gap-2',
  search: classes(
    'flex min-h-11 w-[320px] max-w-full items-center gap-2 rounded-[1rem] border border-sample-border bg-white px-[0.9rem]',
    'text-[0.85rem] text-[#838a93] focus-within:border-[#087f46] focus-within:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)]',
  ),
  searchInput: 'min-w-0 flex-1 border-0 bg-transparent text-[0.85rem] text-app-ink outline-0 placeholder:text-sample-muted',
  toolbar: 'flex flex-wrap items-center justify-between gap-3',
  resultCount: 'm-0 text-base font-bold',
  resultTotal: 'text-brand-primary',
  filters: 'flex flex-wrap items-center gap-3',
  filterLabel: 'flex items-center gap-2 text-xs text-sample-muted',
  filterSelect: classes(
    'min-h-9 w-auto min-w-0 rounded-xl border border-sample-border bg-white px-3 text-xs text-app-ink',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  tableScroll: 'w-full overflow-x-auto',
  emailLink: classes(
    'rounded text-[0.8rem] font-bold text-app-ink no-underline [overflow-wrap:anywhere] hover:text-brand-primary hover:underline',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  mutedText: 'text-sample-muted',
  // 표는 가로로 스크롤되므로 날짜·시각은 한 줄로 둡니다.
  nowrapCell: 'whitespace-nowrap',
  tagList: 'flex flex-wrap gap-1',
  pagination: 'flex items-center justify-end gap-2',
  pageLabel: 'text-[0.78rem] text-sample-muted',
  notice: 'm-0 flex items-start justify-between gap-3 rounded-xl bg-brand-accent px-4 py-3 text-[0.88rem] leading-[1.6] text-app-ink',
  detailGrid: 'grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))]',
  accountHeading: 'flex flex-wrap items-center gap-2',
  accountEmail: 'm-0 text-[1.05rem] font-bold [overflow-wrap:anywhere]',
  infoList: 'm-0 flex flex-col gap-2',
  infoRow: 'flex items-start justify-between gap-3 border-b border-sample-border pb-2 text-[0.85rem] last:border-b-0 last:pb-0',
  infoLabel: 'shrink-0 text-sample-muted',
  infoValue: 'm-0 text-right font-medium text-app-ink [overflow-wrap:anywhere]',
  actionRow: 'flex flex-wrap gap-2',
  actionNote: 'm-0 text-[0.82rem] leading-[1.6] text-sample-muted',
  historyList: 'm-0 flex list-none flex-col gap-2 p-0',
  historyItem: 'flex flex-col gap-1 rounded-[0.85rem] bg-[#f6f7f8] px-3 py-[0.6rem] text-[0.82rem]',
  historyMeta: 'text-[0.72rem] text-sample-muted',
  reasonInput: 'min-h-24 resize-y py-2 leading-[1.6]',
  reasonCount: 'm-0 text-right text-[0.72rem] text-sample-muted',
} as const

/** 요약 수치가 나타내는 상태입니다. 색이 아니라 의미로 고르도록 이름을 상태로 둡니다. */
export type AdminStatTone = 'neutral' | 'ok' | 'warn' | 'danger'

const statValueTones: Record<AdminStatTone, string> = {
  neutral: 'text-app-ink',
  ok: 'text-[#087f46]',
  warn: 'text-[#8a5a00]',
  danger: 'text-[#9a3947]',
}

export function adminStatValueClassName(tone: AdminStatTone) {
  return `${adminAccountsPageStyles.statValue} ${statValueTones[tone]}`
}
