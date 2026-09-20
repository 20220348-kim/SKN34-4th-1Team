function classes(...groups: string[]) {
  return groups.join(' ')
}

// 색상이나 CSS 속성이 아니라 기업 프로필 화면에서 맡는 UI 역할을 이름으로 사용합니다.
// 카드·태그·버튼은 shared/workspace의 공용 스타일을 쓰고 여기서는 프로필 고유 배치만 다룹니다.
export const companyProfileStyles = {
  summaryTop: 'flex items-center gap-4',
  // 카드 제목 옆에 ? 도움말을 붙이는 줄입니다.
  titleRow: 'flex items-center gap-2',
  // 카드 머리 오른쪽에 상태 태그와 수정 버튼을 나란히 둡니다.
  headerActions: 'flex shrink-0 items-center gap-2',
  summaryIdentity: 'flex items-center gap-4',
  summaryAvatar:
    'grid size-[3.25rem] shrink-0 place-items-center rounded-[0.9rem] bg-brand-accent text-[1.2rem] font-black text-app-ink',
  summaryName: 'text-[1.25rem] font-bold tracking-[-0.025em] text-app-ink',
  summaryTags: 'mt-[0.35rem] flex flex-wrap gap-[0.35rem]',
  completion: 'flex flex-col gap-2',
  completionRow: 'flex items-center justify-between text-[0.75rem]',
  completionLabel: 'font-bold text-sample-muted',
  completionValue: 'font-extrabold text-[#087f46]',
  completionTrack: 'h-2 overflow-hidden rounded-full bg-[#f1f2f3]',
  completionBar: 'h-full rounded-full bg-brand-primary',
  completionHint: 'text-[0.75rem] leading-[1.5] text-sample-muted',
  fieldGrid: 'grid grid-cols-1 gap-3 @min-[32rem]/column:grid-cols-2',
  field: 'flex flex-col gap-1 rounded-[0.85rem] bg-[#f6f7f8] px-[0.85rem] py-[0.7rem]',
  emptyField:
    'flex flex-col gap-1 rounded-[0.85rem] border border-dashed border-sample-border bg-white px-[0.85rem] py-[0.7rem]',
  fieldLabel: 'flex items-center gap-1 text-[0.7rem] font-bold text-sample-muted',
  optionalMark: 'font-medium text-sample-muted',
  fieldValue: 'flex items-center gap-2 text-[0.85rem] text-app-ink',
  emptyValue: 'text-[0.85rem] text-sample-muted',
  settingRow: 'flex items-center justify-between gap-4 rounded-[0.85rem] bg-[#f6f7f8] px-4 py-[0.85rem]',
  settingTitle: 'block text-[0.85rem] font-bold text-app-ink',
  settingDescription: 'mt-[0.1rem] block text-[0.74rem] leading-[1.5] text-sample-muted',
  choiceColumns: 'grid grid-cols-1 gap-4 @min-[32rem]/column:grid-cols-2',
  choiceGroup: 'flex flex-col gap-2',
  choiceLabel: 'text-[0.78rem] font-bold text-sample-muted',
  choices: 'flex flex-wrap gap-[0.4rem]',
  choice:
    'inline-flex min-h-9 cursor-pointer items-center rounded-full border px-[0.78rem] py-[0.4rem] text-[0.78rem]',
  selectedChoice: 'border-brand-primary bg-brand-primary font-bold text-white',
  unselectedChoice: 'border-sample-border bg-white font-semibold text-sample-muted hover:border-[#087f46]',
  capabilityGroup: 'flex flex-col gap-2',
  capabilityBox: classes(
    'flex min-h-12 flex-wrap items-center gap-[0.4rem] rounded-[1rem] border border-sample-border bg-white px-[0.9rem] py-2',
  ),
  capabilityChip:
    'inline-flex min-w-0 max-w-full items-center gap-[0.3rem] rounded-full bg-[#e7f6ed] px-[0.65rem] py-[0.3rem] text-[0.75rem] font-bold text-[#087f46] [overflow-wrap:anywhere]',
  capabilityRemove: 'shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[0.75rem] leading-none text-[#087f46]',
  capabilityInput: 'min-w-32 flex-1 border-0 bg-transparent text-[0.85rem] text-app-ink placeholder:text-sample-muted focus:outline-0',
  counter: 'self-end text-[0.72rem] text-sample-muted tabular-nums',
  capabilityTextarea: classes(
    'min-h-24 w-full resize-y rounded-[1rem] border border-sample-border bg-white px-[0.9rem] py-[0.8rem]',
    'text-[0.85rem] leading-[1.6] text-app-ink placeholder:text-sample-muted',
    'focus:border-[#087f46] focus:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)] focus:outline-0',
  ),
  capabilityHint: 'text-[0.72rem] leading-[1.5] text-sample-muted',
  statusRow:
    'flex items-center justify-between gap-4 rounded-[0.85rem] bg-[#f6f7f8] px-[0.85rem] py-[0.7rem] text-[0.85rem] text-app-ink',
  accountRow:
    'flex items-center justify-between gap-4 rounded-[0.85rem] bg-[#f6f7f8] px-[0.85rem] py-[0.7rem]',
  accountLabel: 'block text-[0.7rem] font-bold text-sample-muted',
  accountValue: 'block text-[0.85rem] text-app-ink',
  dangerRow: 'flex justify-end',
  usageList: 'flex flex-col gap-[0.85rem]',
  usageItem: 'flex items-start gap-[0.7rem]',
  usageIcon: 'grid size-8 shrink-0 place-items-center rounded-[0.55rem] bg-[#e7f6ed] text-[#087f46]',
  usageTitle: 'block text-[0.85rem] font-bold text-app-ink',
  usageDescription: 'mt-[0.1rem] block text-[0.75rem] leading-[1.5] text-sample-muted',
  publicityTable:
    'w-full border-separate border-spacing-0 overflow-hidden rounded-[1.4rem] border border-sample-border text-[0.72rem]',
  publicityHeadCell:
    'bg-[#f6f7f8] px-[0.7rem] py-[0.55rem] text-left font-bold whitespace-nowrap text-app-ink',
  publicityCell: 'border-t border-sample-border px-[0.7rem] py-[0.55rem] text-sample-muted',
  publicOpen: 'border-t border-sample-border px-[0.7rem] py-[0.55rem] font-bold text-[#087f46]',
  publicClosed: 'border-t border-sample-border px-[0.7rem] py-[0.55rem] text-sample-muted',
  notice: 'm-0 rounded-[0.85rem] bg-[#e7f6ed] px-4 py-3 text-[0.8rem] font-semibold text-[#087f46]',
  form: 'flex flex-col gap-3',
  formGrid: 'grid grid-cols-1 gap-3 @min-[32rem]/column:grid-cols-2',
  formField: 'flex min-w-0 flex-col gap-1',
  formFieldWide: '@min-[32rem]/column:col-span-2',
  formLabel: 'flex items-center gap-1 text-[0.72rem] font-bold text-sample-muted',
  input: classes(
    'min-h-10 w-full rounded-[0.75rem] border border-sample-border bg-white px-3 text-[0.85rem] text-app-ink',
    'placeholder:text-sample-muted focus:border-[#087f46] focus:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)] focus:outline-0',
    'aria-[invalid=true]:border-[#c9505f]',
  ),
  lookupRow: 'flex flex-wrap items-end gap-2 [&>label]:min-w-[14rem] [&>label]:flex-1',
  lookupResult: 'flex flex-col gap-1 rounded-[0.85rem] bg-[#f6f7f8] px-4 py-3',
  lookupHeadline: 'flex flex-wrap items-center gap-2',
  lookupName: 'text-[0.95rem] font-bold text-app-ink',
  lookupDetail: 'text-[0.75rem] text-sample-muted',
  lookupWarning: 'text-[0.75rem] font-bold text-[#8a5a00]',
  formError: 'm-0 text-[0.78rem] font-bold text-[#9a3947]',
  formHint: 'text-[0.72rem] text-sample-muted',
  formActions: 'flex flex-wrap justify-end gap-2',
  // 완성도 막대 아래 한 줄로 흐르는 체크리스트입니다. 좁으면 줄을 바꿉니다.
  checklist: 'flex flex-wrap gap-x-5 gap-y-[0.45rem] pt-1 text-[0.8rem]',
  checklistItem: 'relative flex items-center gap-[0.55rem]',
  doneMark: 'grid size-[1.125rem] shrink-0 place-items-center rounded-full bg-brand-accent text-app-ink',
  todoMark: 'size-[1.125rem] shrink-0 rounded-full border border-sample-border bg-white',
  doneLabel: 'text-app-ink',
  todoLabel: 'text-sample-muted',
} as const

export function companyProfileChoiceClassName(isSelected: boolean) {
  const variant = isSelected
    ? companyProfileStyles.selectedChoice
    : companyProfileStyles.unselectedChoice
  return `${companyProfileStyles.choice} ${variant}`
}
