function classes(...groups: string[]) {
  return groups.join(' ')
}

const formControl = classes(
  'box-border w-full rounded-[1rem] border px-[0.9rem] py-[0.8rem]',
  'border-sample-border bg-white text-app-ink',
  'focus:border-brand-primary focus:[outline:3px_solid_rgb(8_127_70_/_12%)]',
)
const fieldError = 'text-[0.85rem] font-semibold text-[#9a3947]'

// Hook 화면과 Redux 화면에서 같은 역할을 하는 요소는 하나의 이름과 스타일을 공유합니다.
// 두 화면은 상태 관리 방식만 비교해야 하므로 시각 스타일의 우연한 차이를 만들지 않습니다.
export const sampleItemStyles = {
  page: 'mx-auto w-[calc(100%_-_2rem)] max-w-[960px] py-16 max-sample:py-8',
  backButton: classes(
    'mb-6 inline-flex cursor-pointer items-center gap-[0.45rem] rounded-full',
    'border border-sample-border bg-white px-[0.85rem] py-[0.65rem]',
    'text-[0.85rem] font-bold text-app-ink no-underline hover:border-brand-primary hover:bg-[#f6f7f8] hover:text-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  hero:
    'mb-8 grid grid-cols-[minmax(0,1fr)_minmax(280px,360px)] items-end gap-8 max-sample:grid-cols-1',
  eyebrow:
    'mt-0 mb-[0.65rem] text-[0.78rem] font-extrabold tracking-[0.12em] text-brand-primary uppercase',
  heroTitle:
    'm-0 text-[clamp(2rem,5vw,3.4rem)] font-bold tracking-[-0.04em] text-sample-heading',
  heroDescription: 'my-4 leading-[1.65] text-sample-muted',
  form: classes(
    'grid gap-5 rounded-[1.4rem] border border-sample-border bg-white',
    'p-[clamp(1.5rem,4vw,2.5rem)] shadow-[0_20px_50px_rgb(32_33_36_/_5%)]',
  ),
  formHeader:
    'flex items-start justify-between gap-4 max-sample:flex-col max-sample:items-stretch',
  formEyebrow:
    'mt-0 mb-[0.65rem] text-[0.78rem] font-extrabold tracking-[0.12em] text-sample-muted uppercase',
  formTitle: 'm-0 text-[1.7rem] font-bold tracking-[-0.04em] text-sample-heading',
  formDescription: 'mt-4 mb-0 leading-[1.65] text-sample-muted',
  resetButton: classes(
    'shrink-0 cursor-pointer rounded-full border bg-white px-[0.8rem] py-[0.65rem]',
    'border-sample-border text-[0.82rem] font-extrabold text-app-ink',
    'hover:border-brand-primary hover:bg-[#f6f7f8] hover:text-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  field: 'grid gap-2 font-bold text-app-ink',
  optionalLabel: 'text-[0.8rem] font-medium not-italic text-sample-muted',
  formControl,
  textareaControl: classes(formControl, 'resize-y'),
  fieldError,
  formActions:
    'flex items-center justify-between gap-4 pt-2 max-sample:flex-col max-sample:items-stretch',
  actionDescription: 'mt-1 mb-0 text-[0.9rem] leading-[1.65] text-sample-muted',
  submitButton: classes(
    'shrink-0 cursor-pointer rounded-full border-0 bg-sample-primary px-4 py-[0.8rem]',
    'font-extrabold text-white hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-[0.45]',
  ),
  result: 'grid gap-[0.4rem] rounded-[1rem] border border-sample-border bg-[#f6f7f8] p-4 text-app-ink',
  resultTitle: 'text-base text-brand-primary',
  resultDetail: 'leading-normal text-sample-muted',
  preparationError: classes('m-0', fieldError),
  versionSwitch:
    'mb-8 inline-flex gap-[0.35rem] rounded-full border border-sample-border bg-[#f6f7f8] p-[0.35rem]',
  versionButton:
    'inline-flex cursor-pointer items-center rounded-full border-0 px-[0.9rem] py-[0.65rem] text-[0.86rem] font-extrabold no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  activeVersionButton:
    'bg-sample-primary text-white shadow-[0_4px_12px_rgb(8_127_70_/_14%)]',
  inactiveVersionButton: 'bg-transparent text-sample-muted hover:bg-brand-accent hover:text-[#066538]',
  comparison: classes(
    'mb-8 grid grid-cols-[minmax(200px,0.65fr)_minmax(0,1.35fr)] items-start gap-6',
    'rounded-[1.4rem] border border-sample-border bg-app-canvas p-[1.35rem]',
    'max-sample:grid-cols-1',
  ),
  comparisonTitle: 'm-0 text-[1.25rem] font-bold tracking-[-0.025em] text-sample-heading',
  comparisonTable:
    'grid divide-y divide-sample-border overflow-hidden rounded-[1rem] border border-sample-border bg-white',
  comparisonRow:
    'grid grid-cols-[0.8fr_1fr_1fr] divide-x divide-sample-border max-sample:grid-cols-[0.9fr_1fr_1fr]',
  comparisonCell: 'px-3 py-[0.65rem] text-[0.82rem]',
  comparisonHeaderCell: 'bg-[#f6f7f8] text-app-ink',
  comparisonBodyCell: 'text-sample-muted',
  comparisonActiveCell: 'bg-brand-accent font-extrabold text-[#066538]',
} as const

export function sampleVersionButtonClassName(isActive: boolean) {
  const variant = isActive
    ? sampleItemStyles.activeVersionButton
    : sampleItemStyles.inactiveVersionButton
  return `${sampleItemStyles.versionButton} ${variant}`
}

export function sampleComparisonCellClassName(
  isActive: boolean,
  cellType: 'header' | 'body',
) {
  const inactive =
    cellType === 'header'
      ? sampleItemStyles.comparisonHeaderCell
      : sampleItemStyles.comparisonBodyCell
  return `${sampleItemStyles.comparisonCell} ${
    isActive ? sampleItemStyles.comparisonActiveCell : inactive
  }`
}
