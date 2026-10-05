function classes(...groups: string[]) {
  return groups.join(' ')
}

const fieldControl = classes(
  'min-h-11 rounded-xl border border-line bg-surface px-3 text-xs text-app-ink',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
)

// 감사 기록 화면 고유 배치입니다. 카드·표·태그·버튼은 shared/workspace, 표 가로 스크롤과 링크는 계정 화면 스타일을 함께 씁니다.
export const adminAuditLogsPageStyles = {
  intro: 'm-0 text-[0.82rem] leading-[1.6] text-ink-muted',
  // 좁은 폭에서는 조건 칸이 줄을 바꿔 쌓이고, 조회 버튼은 마지막 줄 끝에 남습니다.
  filterForm: 'flex flex-wrap items-end gap-3',
  field: 'flex flex-col gap-1 text-xs text-ink-muted',
  dateInput: classes(fieldControl, 'w-[150px] max-w-full'),
  idInput: classes(fieldControl, 'w-[110px] max-w-full'),
  actionSelect: classes(fieldControl, 'w-[160px] max-w-full'),
  formActions: 'flex min-h-11 items-center gap-3',
  formError: 'm-0 text-[0.78rem] leading-[1.6] text-danger',
  timeCell: 'whitespace-nowrap tabular-nums',
  personCell: 'flex min-w-0 flex-col gap-0.5',
  personEmail: 'font-bold text-app-ink [overflow-wrap:anywhere]',
  personId: 'text-[0.68rem] text-ink-subtle',
  summaryCell: 'block min-w-[12rem] max-w-[22rem] font-mono text-[0.7rem] [overflow-wrap:anywhere]',
  userAgent: 'block max-w-[14rem] truncate text-[0.68rem] text-ink-subtle',
  pagination: 'flex items-center justify-end gap-2',
  pageLabel: 'text-[0.78rem] text-ink-muted',
} as const
