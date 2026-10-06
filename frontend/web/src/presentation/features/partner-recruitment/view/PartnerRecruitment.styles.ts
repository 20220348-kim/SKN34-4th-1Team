function classes(...groups: string[]) {
  return groups.join(' ')
}

// 색상이나 CSS 속성이 아니라 파트너 모집 화면들에서 맡는 UI 역할을 이름으로 사용합니다.
// 카드·태그·버튼은 shared/workspace의 공용 스타일을 쓰고 여기서는 모집 화면 고유 배치를 다룹니다.
export const partnerRecruitmentStyles = {
  search: classes(
    'flex min-h-11 w-[320px] max-w-full items-center gap-2 rounded-[1rem] border border-line bg-white px-[0.9rem]',
    'text-[0.85rem] text-ink-subtle focus-within:border-brand-primary focus-within:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)]',
  ),
  searchRow: 'flex flex-wrap items-center gap-2',
  searchInput: 'min-w-0 flex-1 border-0 bg-transparent text-[0.85rem] text-ink outline-0 placeholder:text-ink-muted',
  plainList: 'm-0 flex list-disc flex-col gap-1 pl-5 text-[0.78rem] leading-[1.5] text-ink-muted',
  filterPanel: 'flex flex-col gap-3 rounded-[1rem] border border-line bg-white p-4',
  filterFooter: 'flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3',
  resultCount: 'm-0 text-[0.78rem] text-ink-muted',
  // 결과 머리줄(필터 검색과 같은 배치): 왼쪽 "검색 결과 n건", 오른쪽 정렬 드롭다운.
  resultHead: 'flex flex-wrap items-center justify-between gap-3',
  resultTitle: 'm-0 text-base font-bold text-ink',
  sortLabel: 'flex items-center gap-2 text-xs text-ink-muted',
  sortSelect: 'min-h-9 cursor-pointer rounded-xl border border-line bg-white px-3 text-xs font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  pagination: 'flex items-center justify-center gap-3 pt-2',
  // 폭에 따라 3열·2열·1열로 저절로 줄어드는 격자입니다. 한 줄은 최대 3열(카드 폭이 전체의 1/3 이상)이고 같은 줄의 카드는 같은 높이로 늘어납니다.
  cardGrid: 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,max(300px,calc((100%_-_2rem)/3))),1fr))]',
  cardTop: 'flex items-center justify-between gap-3',
  // 카드 제목·눈썹 옆에 ? 도움말을 붙이는 줄입니다.
  titleRow: 'flex items-center gap-2',
  cardDeadline: 'text-[0.74rem] font-extrabold text-[#b75561]',
  mineDeadline: 'text-[0.74rem] font-extrabold text-ink-muted',
  cardTitle:
    'm-0 line-clamp-2 text-[1.02rem] font-bold leading-[1.4] tracking-[-0.025em] text-ink [overflow-wrap:anywhere]',
  cardProgram: 'm-0 line-clamp-2 text-[0.75rem] leading-[1.5] text-ink-muted',
  authorRow: 'flex items-center gap-2 rounded-[0.85rem] bg-[#f6f7f8] px-3 py-[0.6rem]',
  authorAvatar:
    'grid size-7 shrink-0 place-items-center rounded-[0.5rem] text-[0.75rem] font-extrabold',
  authorAvatarOther: 'bg-brand-primary text-white',
  authorAvatarMine: 'bg-brand-soft text-ink',
  authorName: 'block text-[0.78rem] font-bold text-ink',
  authorSummary: 'mt-[0.05rem] block text-[0.68rem] text-ink-muted',
  // 긴 태그는 한 줄 말줄임으로 자르고 전체 문구는 title로 보여 줍니다.
  tagRow: 'flex flex-wrap gap-[0.35rem] [&>span]:max-w-full [&>span]:shrink [&>span]:truncate',
  // 카드 높이가 달라도 하단 줄은 항상 바닥에 붙습니다.
  cardFooter: 'mt-auto flex flex-wrap items-center justify-between gap-3 pt-1',
  cardFooterNote: 'flex flex-wrap items-center gap-[0.35rem] text-[0.72rem] text-ink-muted',
  sideList: 'flex flex-col gap-2',
  sideItem: 'flex flex-col gap-[0.3rem] rounded-[0.85rem] bg-[#f6f7f8] px-[0.85rem] py-[0.7rem]',
  sideItemTitle: 'text-[0.8rem] font-bold leading-[1.4] text-ink',
  noticeCard:
    'flex flex-col gap-[0.6rem] rounded-[1.4rem] border border-line bg-[#f6f7f8] p-[1.2rem]',
  noticeText: 'm-0 text-[0.75rem] leading-[1.6] text-ink-muted',

  detailTitle:
    'm-0 text-[1.5rem] font-bold leading-[1.35] tracking-[-0.03em] text-ink [overflow-wrap:anywhere]',
  detailAuthorCard: 'flex flex-wrap items-center justify-between gap-4 rounded-[1rem] bg-[#f6f7f8] px-4 py-[0.85rem]',
  detailAuthorAvatar:
    'grid size-10 shrink-0 place-items-center rounded-[0.85rem] bg-brand-primary text-[0.95rem] font-extrabold text-white',
  detailAuthorName: 'text-[0.9rem] font-bold text-ink',
  detailAuthorSummary: 'mt-[0.15rem] block text-[0.72rem] text-ink-muted',
  conditionGrid: 'grid grid-cols-1 gap-[0.6rem] @min-[32rem]/column:grid-cols-3',
  conditionCell: 'flex flex-col gap-[0.2rem] rounded-[0.85rem] border border-line px-[0.85rem] py-[0.7rem]',
  conditionLabel: 'text-[0.68rem] font-bold text-ink-muted',
  conditionValue: 'text-[0.85rem] font-bold text-ink',
  rawBox: 'flex flex-col gap-1 rounded-[0.85rem] bg-[#f6f7f8] p-[0.7rem] text-[0.75rem] text-ink-muted',
  rawBoxLabel: 'font-bold text-ink',
  linkRow: 'flex flex-wrap items-center gap-3',
  pillLink:
    'rounded-[0.55rem] bg-brand-soft px-[0.7rem] py-[0.55rem] text-[0.74rem] font-extrabold text-brand-primary no-underline hover:bg-[#d7efdf]',
  saveNotice: 'text-[0.78rem] font-semibold text-brand-primary',
  bodyParagraph: 'm-0 text-[0.88rem] leading-[1.7] text-ink',
  disclaimer: 'm-0 text-[0.72rem] leading-[1.55] text-ink-muted',
  matchRow:
    'flex items-center justify-between gap-2 rounded-[0.6rem] bg-[#f6f7f8] px-3 py-[0.6rem] text-[0.78rem] text-ink',
  proposalCard: classes(
    'flex flex-col gap-[0.9rem] rounded-[1.4rem] border border-line bg-white p-[1.35rem]',
    'shadow-[0_20px_50px_rgb(32_33_36_/_5%)]',
  ),
  proposalTextarea: classes(
    'min-h-28 w-full resize-y rounded-[1rem] border border-line bg-white px-[0.9rem] py-[0.8rem]',
    'text-[0.85rem] leading-[1.6] text-ink placeholder:text-ink-muted',
    'focus:border-brand-primary focus:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)] focus:outline-0',
  ),
  proposalCounter: 'text-right text-[0.7rem] font-medium text-ink-muted',
  checkboxLabel: 'flex items-center gap-[0.55rem] text-[0.8rem] text-ink',
  checkbox: 'size-[1.05rem] shrink-0 accent-brand-primary',
  proposalSubmit: classes(
    'min-h-12 w-full cursor-pointer rounded-full border-0 bg-brand-primary px-4 py-[0.85rem]',
    'text-[0.9rem] font-extrabold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60',
  ),
  flowRow: 'flex flex-wrap items-center gap-[0.35rem] text-[0.72rem] font-bold text-ink-muted',
  flowStep: 'inline-flex rounded-[0.35rem] border border-line bg-white px-[0.45rem] py-[0.25rem]',

  form: classes(
    '@container/column flex min-w-0 flex-col gap-6 rounded-[1.25rem] border border-line bg-white p-9',
    'shadow-[0_20px_50px_rgb(32_33_36_/_5%)] max-chat:p-5',
  ),
  formSection: 'flex flex-col gap-4',
  formSectionHeader: 'flex flex-wrap items-center justify-between gap-3',
  formSectionTitleGroup: 'flex flex-wrap items-center gap-[0.6rem]',
  formStepBadge:
    'grid size-[1.6rem] shrink-0 place-items-center rounded-full bg-brand-primary text-[0.72rem] font-extrabold text-white',
  formSectionTitle: 'm-0 text-[1.1rem] font-bold tracking-[-0.025em] text-ink',
  formSectionHint: 'text-[0.75rem] text-ink-muted',
  formDivider: 'h-px bg-line',
  selectedProgram:
    'flex items-center justify-between gap-4 rounded-[0.85rem] border border-brand-primary bg-white px-4 py-[0.9rem]',
  selectedProgramTitle: 'text-[0.95rem] font-bold text-ink',
  selectedProgramMeta: 'text-[0.72rem] text-ink-muted',
  // 중복 검토·신청 문서의 관심 공고함 열기 버튼과 같은 모양입니다.
  pickerButton:
    'flex w-full cursor-pointer items-center justify-between rounded-xl border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold hover:border-brand-primary hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-brand-primary aria-[invalid=true]:border-red-500',
  fieldHintLink: 'font-semibold text-brand-primary underline underline-offset-2',
  fieldRow: 'grid grid-cols-1 gap-[1.1rem] @min-[28rem]/column:grid-cols-2',
  field: 'flex flex-col gap-2 text-[0.9rem] font-bold text-ink',
  fieldLabelRow: 'flex items-center gap-1',
  unitField: 'flex items-center gap-2',
  unitLabel: 'shrink-0 text-[0.85rem] font-semibold text-ink-muted',
  optionalMark: 'text-[0.8rem] font-medium text-ink-muted',
  fieldControl: classes(
    'box-border min-h-12 w-full rounded-[1rem] border border-line bg-white px-[0.9rem] py-[0.8rem]',
    'text-[0.95rem] font-normal text-ink placeholder:text-ink-muted',
    'focus:border-brand-primary focus:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)] focus:outline-0',
  ),
  fieldTextarea: 'min-h-36 resize-y leading-[1.65]',
  fieldHint: 'text-[0.75rem] font-medium text-ink-muted',
  roleChoices: 'flex flex-wrap gap-2',
  roleChoice:
    'inline-flex min-h-10 cursor-pointer items-center rounded-full border px-[0.85rem] py-[0.5rem] text-[0.8rem]',
  selectedRoleChoice: 'border-brand-primary bg-brand-primary font-bold text-white',
  unselectedRoleChoice: 'border-line bg-white font-semibold text-ink-muted hover:border-brand-primary',
  capabilityBox: classes(
    'flex min-h-12 flex-wrap items-center gap-[0.4rem] rounded-[1rem] border border-line bg-white',
    'px-[0.9rem] py-2',
  ),
  capabilityChip:
    'inline-flex min-w-0 max-w-full items-center gap-[0.3rem] rounded-full bg-brand-soft px-[0.65rem] py-[0.3rem] text-[0.75rem] font-bold text-brand-primary [overflow-wrap:anywhere]',
  capabilityRemove: 'shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[0.75rem] leading-none text-brand-primary',
  capabilityInput:
    'min-w-32 flex-1 border-0 bg-transparent text-[0.85rem] text-ink placeholder:text-ink-muted focus:outline-0',
  formActions: 'flex items-center justify-between gap-6 pt-2 max-chat:flex-col max-chat:items-stretch',
  formActionsNote: 'm-0 text-[0.82rem] leading-[1.6] text-ink-muted',
  formActionButtons: 'flex shrink-0 items-center gap-2',
  formSubmitButton: classes(
    'min-h-12 cursor-pointer rounded-full border-0 bg-brand-primary px-5 py-[0.85rem]',
    'text-[0.95rem] font-extrabold text-white hover:bg-brand-hover',
  ),
  formCancelButton: classes(
    'inline-flex min-h-12 cursor-pointer items-center justify-center rounded-full border border-line bg-white',
    'px-4 py-[0.85rem] text-[0.9rem] font-bold text-ink-muted no-underline hover:border-brand-primary hover:text-brand-primary',
  ),
  requirementRow: 'flex items-start gap-2 text-[0.78rem] leading-[1.5] text-ink',
} as const


export function partnerRoleChoiceClassName(isSelected: boolean) {
  const variant = isSelected
    ? partnerRecruitmentStyles.selectedRoleChoice
    : partnerRecruitmentStyles.unselectedRoleChoice
  return `${partnerRecruitmentStyles.roleChoice} ${variant}`
}
