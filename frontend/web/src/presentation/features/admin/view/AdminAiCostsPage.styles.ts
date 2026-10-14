function classes(...groups: string[]) {
  return groups.join(' ')
}

const fieldControl = classes(
  'min-h-11 rounded-xl border border-line bg-surface px-3 text-xs text-ink',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
)

// AI 비용 화면 고유 배치입니다. 카드·표·버튼은 shared/workspace, 요약 칸·표 스크롤·링크는 계정 화면 스타일을 함께 씁니다.
export const adminAiCostsPageStyles = {
  intro: 'm-0 text-[0.82rem] leading-[1.6] text-ink-muted',
  toolbar: 'flex flex-wrap items-end justify-between gap-3',
  filterForm: 'flex flex-wrap items-end gap-3',
  field: 'flex flex-col gap-1 text-xs text-ink-muted',
  dateInput: classes(fieldControl, 'w-[150px] max-w-full'),
  textInput: classes(fieldControl, 'w-[190px] max-w-full'),
  numberInput: classes(fieldControl, 'w-[110px] max-w-full tabular-nums'),
  tierSelect: classes(fieldControl, 'w-[150px] max-w-full'),
  formActions: 'flex min-h-11 items-center gap-3',
  formError: 'm-0 text-[0.78rem] leading-[1.6] text-danger',
  statNote: 'text-[0.7rem] leading-[1.5] text-ink-muted',
  numberCell: 'whitespace-nowrap text-right tabular-nums',
  detailCell: 'min-w-[10rem] break-keep text-right tabular-nums',
  // 기능명과 숫자를 함께 읽을 수 있는 폭이 있을 때만 두 표를 나란히 배치합니다.
  sectionGrid: 'grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,700px),1fr))]',
  sectionNote: 'm-0 text-[0.75rem] leading-[1.6] text-ink-muted',
  featureCell: 'min-w-[14rem] break-keep font-medium text-ink',
  // 표가 가로로 스크롤되므로 모델 이름은 끊지 않습니다.
  modelCell: 'whitespace-nowrap font-mono text-[0.7rem] text-ink',
} as const
