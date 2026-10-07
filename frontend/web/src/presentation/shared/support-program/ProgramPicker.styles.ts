const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'

/** 지원 공고 상태 배지 · D-n 배지 · 출처 배지입니다. 고른 공고 카드와 공고 고르기 행이 함께 씁니다. */
export const programBadgeStyles = {
  row: 'flex flex-wrap items-center gap-1.5',
  badge: 'inline-flex h-[22px] items-center gap-1 rounded-md border border-transparent px-[7px] text-[0.72rem] font-bold whitespace-nowrap',
  dot: 'size-1.5 rounded-full bg-current',
  brand: 'bg-brand-soft text-brand-primary',
  info: 'bg-info-soft text-info',
  neutral: 'bg-surface-muted text-ink-muted',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  outline: 'border-line bg-white text-ink-muted',
} as const

/**
 * 공고 고르기 패널입니다(신청 문서 새 문서 · 중복 지원 검토 1단계가 함께 씀). PC는 오른쪽 400px 옆 패널(화면 높이 전체),
 * 600px 미만은 화면 전체 높이 시트입니다. 뒤 화면을 흐린 배경으로 덮어 지금은 패널에서 고르는 중임을 알리고, 흐린 곳을 누르면 닫힙니다.
 * 600px 미만은 [✕]를 제목 왼쪽에 둡니다.
 */
export const programPickerStyles = {
  overlay: 'fixed inset-0 z-50 bg-black/35',
  panel: 'fixed inset-y-0 right-0 flex w-[400px] max-w-full flex-col border-l border-line bg-white shadow-[-12px_0_32px_rgb(32_33_36_/_12%)] outline-none max-[599px]:inset-x-0 max-[599px]:h-dvh max-[599px]:w-full max-[599px]:border-l-0 max-[599px]:shadow-none',
  header: 'flex items-start gap-3 border-b border-line px-5 pt-5 pb-4 max-[599px]:items-center max-[599px]:gap-1 max-[599px]:px-3 max-[599px]:pt-3 max-[599px]:pb-2',
  headerText: 'flex min-w-0 flex-1 flex-col gap-0.5',
  title: 'm-0 text-base font-extrabold text-ink',
  sub: 'm-0 text-[0.78rem] text-ink-muted',
  close: `grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-base text-ink-muted hover:bg-surface-muted hover:text-ink ${focus} max-[599px]:order-first max-[599px]:size-10 max-[599px]:text-lg max-[599px]:text-ink`,
  body: 'flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 max-[599px]:px-4',
  // 관심 공고함 · 전체 검색 세그먼트. 패널 안쪽 폭을 넘지 않고 두 탭이 폭을 반씩 나눕니다(글자가 길면 줄바꿈).
  segment: 'flex w-full min-w-0 max-w-full shrink-0 gap-[3px] rounded-full bg-surface-muted p-[3px]',
  segmentTab: `flex min-h-[34px] min-w-0 flex-[1_1_0] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent px-2 py-1 text-center text-[0.8125rem] leading-[1.3] font-bold text-ink-muted hover:text-ink aria-selected:bg-white aria-selected:text-ink aria-selected:shadow-[0_1px_3px_rgb(32_33_36_/_12%)] ${focus} max-[599px]:min-h-[38px]`,
  tabPanel: 'flex min-w-0 flex-col gap-3',
  searchRow: 'flex gap-2',
  searchInput: `h-10 min-w-0 flex-1 rounded-xl border border-line-strong bg-white px-3 text-[0.875rem] text-ink placeholder:text-ink-subtle focus-visible:border-brand-primary ${focus} max-[599px]:text-base`,
  filterToggle: `inline-flex h-8 cursor-pointer items-center gap-1 self-start rounded-full border border-line-strong bg-white px-3 text-[0.75rem] font-bold text-ink hover:border-brand-primary aria-expanded:border-brand-primary aria-expanded:text-brand-primary ${focus}`,
  filters: 'grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface-muted p-3',
  filterField: 'flex min-w-0 flex-col gap-1',
  filterLabel: 'text-[0.72rem] font-bold text-ink-muted',
  multiInput: 'w-full min-w-0 justify-between',
  filterHint: 'col-span-2 m-0 text-[0.72rem] text-ink-muted',
  filterInput: 'h-10 w-full min-w-0 rounded-xl border border-line-strong bg-white px-3 text-[0.8125rem] font-semibold text-ink focus-visible:outline-2 focus-visible:outline-brand-primary disabled:opacity-50',
  chips: 'flex flex-wrap items-center gap-1.5',
  chip: `inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-line bg-white px-2.5 text-[0.72rem] font-semibold text-ink hover:border-brand-primary ${focus}`,
  resetLink: `ml-auto cursor-pointer rounded border-0 bg-transparent p-0 text-[0.72rem] font-bold text-brand-primary hover:underline ${focus}`,
  count: 'm-0 text-[0.72rem] text-ink-muted tabular-nums',
  list: 'm-0 flex list-none flex-col gap-2 p-0',
  // 고를 수 없는 행(다른 칸에서 이미 고른 공고)은 흐리게 두고 누르지 못하게 합니다.
  row: 'flex flex-col gap-2 rounded-2xl border border-line bg-white px-3.5 py-3 has-[:checked]:border-brand-primary has-[:checked]:shadow-[0_0_0_3px_rgb(8_127_70_/_14%)] has-[:disabled]:bg-surface-muted has-[:disabled]:opacity-60',
  rowLabel: 'flex cursor-pointer items-start gap-2.5 has-[:disabled]:cursor-not-allowed',
  radio: 'mt-0.5 size-4 shrink-0 accent-brand-primary',
  rowText: 'flex min-w-0 flex-1 flex-col gap-1',
  rowTitle: 'text-[0.85rem] leading-[1.45] font-bold text-ink [overflow-wrap:anywhere]',
  rowMeta: 'text-[0.75rem] text-ink-muted tabular-nums',
  // 행 배지 줄 오른쪽 끝에 붙는 표시("지금 공고" · "사업 1로 고름")입니다.
  rowTags: 'ml-auto flex flex-wrap items-center gap-1.5',
  // 행 아래 한 줄 안내(자동 분석 미지원 등)입니다. 라디오 폭만큼 들여 공고명과 줄을 맞춥니다.
  rowNote: 'm-0 pl-[26px] text-[0.75rem] font-semibold text-warning',
  state: 'flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-[0.8125rem] text-ink-muted',
  footer: 'flex items-center gap-2 border-t border-line px-5 pt-3 pb-4 max-[599px]:px-4 max-[599px]:pb-[calc(1rem+env(safe-area-inset-bottom))] [&>*:last-child]:flex-1 max-[599px]:[&>*:first-child]:flex-1 max-[599px]:[&>*:last-child]:flex-[2] max-[599px]:[&>button]:h-11',
  // 버튼. md는 40px, sm은 32px입니다(신청 문서 새 문서 화면의 버튼과 같은 모양).
  primary: `inline-flex h-10 cursor-pointer items-center justify-center gap-1 rounded-full border-0 bg-brand-primary px-5 text-[0.8125rem] font-bold text-white no-underline hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  secondary: `inline-flex h-10 cursor-pointer items-center justify-center gap-1 rounded-full border border-line-strong bg-white px-4 text-[0.8125rem] font-bold text-ink no-underline hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  secondarySm: `inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full border border-line-strong bg-white px-3 text-[0.75rem] font-bold text-ink hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  primarySm: `inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary px-3 text-[0.75rem] font-bold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  // [취소]처럼 물러나는 동작입니다. 회색 글자만 두지 않고 옅은 테두리를 둡니다.
  ghost: `inline-flex h-10 cursor-pointer items-center justify-center rounded-full border border-line bg-transparent px-4 text-[0.8125rem] font-bold text-ink no-underline hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  buttonSpinner: 'size-3 shrink-0 rounded-full border-[1.5px] border-current border-t-transparent motion-safe:animate-spin',
  // 불러오는 동안의 막대와, 다시 검색하는 동안 기존 결과를 흐리게 둔 채 누르지 못하게 하는 표시입니다.
  bar: 'block rounded-md bg-surface-muted motion-safe:animate-pulse',
  stale: 'pointer-events-none opacity-50',
} as const
