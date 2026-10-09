import { companyFormStyles } from '../../../shared/company/CompanyForm.styles'

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
    'grid size-[3.25rem] shrink-0 place-items-center rounded-[0.9rem] bg-brand-soft text-[1.2rem] font-black text-ink',
  summaryName: 'text-[1.25rem] font-bold tracking-[-0.025em] text-ink',
  summaryTags: 'mt-[0.35rem] flex flex-wrap gap-[0.35rem]',
  completion: 'flex flex-col gap-2',
  completionRow: 'flex items-center justify-between text-[0.75rem]',
  completionLabel: 'font-bold text-ink-muted',
  completionValue: 'font-extrabold text-brand-primary',
  completionTrack: 'h-2 overflow-hidden rounded-full bg-[#f1f2f3]',
  completionBar: 'h-full rounded-full bg-brand-primary',
  completionHint: 'text-[0.75rem] leading-[1.5] text-ink-muted',
  fieldGrid: 'grid grid-cols-1 gap-3 @min-[32rem]/column:grid-cols-2',
  field: 'flex flex-col gap-1 rounded-[0.85rem] bg-[#f6f7f8] px-[0.85rem] py-[0.7rem]',
  emptyField:
    'flex flex-col gap-1 rounded-[0.85rem] border border-dashed border-line bg-white px-[0.85rem] py-[0.7rem]',
  fieldLabel: 'flex items-center gap-1 text-[0.7rem] font-bold text-ink-muted',
  fieldValue: 'flex items-center gap-2 text-[0.85rem] text-ink',
  emptyValue: 'text-[0.85rem] text-ink-muted',
  settingRow: 'flex items-center justify-between gap-4 rounded-[0.85rem] bg-[#f6f7f8] px-4 py-[0.85rem]',
  settingTitle: 'block text-[0.85rem] font-bold text-ink',
  settingDescription: 'mt-[0.1rem] block text-[0.74rem] leading-[1.5] text-ink-muted',
  // 관심 공고 마감 알림 줄입니다. 켜면 받는 방법을 같은 상자 안에 펼칩니다.
  reminderBox: 'flex flex-col gap-3 rounded-[0.85rem] bg-[#f6f7f8] px-4 py-[0.85rem]',
  reminderHeader: 'flex items-center justify-between gap-4',
  reminderOptions: 'flex flex-col gap-[0.65rem] border-t border-line pt-3',
  reminderChannel: 'flex items-start gap-2 text-[0.8rem] [&>input]:mt-[0.2rem]',
  reminderNote: 'm-0 text-[0.74rem] leading-[1.5] text-ink-muted',
  // 요금제와 이용량 카드입니다. 오늘 · 이번 달로 묶어 다시 채워지는 때를 묶음 머리에 한 번 적고,
  // 기능마다 이름 · 남은 양, 진행 막대, 한도 중 쓴 양을 한 상자에 둡니다. 남은 양이 한도의 20% 이하면 글자와 막대를 경고 색으로 바꿉니다.
  planHeaderSide: 'inline-flex shrink-0 items-center gap-2.5',
  planUsageGroup: 'flex flex-col gap-2',
  planUsageGroupHead: 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5',
  planUsageGroupTitle: 'text-[0.78rem] font-bold text-ink-muted',
  planUsageRows: 'm-0 flex list-none flex-col gap-2 p-0',
  planUsageRow: 'flex flex-col gap-1.5 rounded-[0.85rem] bg-[#f6f7f8] px-4 py-[0.85rem]',
  planUsageRowHead: 'flex items-center justify-between gap-4',
  planUsageCount: 'shrink-0 text-[0.8rem] font-bold text-ink tabular-nums',
  planUsageCountWarning: 'shrink-0 text-[0.8rem] font-bold text-warning tabular-nums',
  planUsageTrack: 'h-2 overflow-hidden rounded-full bg-track',
  planUsageBar: 'h-full rounded-full bg-brand-primary',
  planUsageBarWarning: 'h-full rounded-full bg-warning',
  planUsageReset: 'text-[0.74rem] leading-[1.5] text-ink-muted',
  planNote: 'm-0 text-[0.74rem] leading-[1.5] text-ink-muted',
  choiceColumns: 'grid grid-cols-1 gap-4 @min-[32rem]/column:grid-cols-2',
  choiceGroup: 'flex flex-col gap-2',
  choiceLabel: 'text-[0.78rem] font-bold text-ink-muted',
  choices: 'flex flex-wrap gap-[0.4rem]',
  choice:
    'inline-flex min-h-9 cursor-pointer items-center rounded-full border px-[0.78rem] py-[0.4rem] text-[0.78rem]',
  selectedChoice: 'border-brand-primary bg-brand-primary font-bold text-white',
  unselectedChoice: 'border-line bg-white font-semibold text-ink-muted hover:border-brand-primary',
  capabilityGroup: 'flex flex-col gap-2',
  capabilityBox: classes(
    'flex min-h-12 flex-wrap items-center gap-[0.4rem] rounded-[1rem] border border-line bg-white px-[0.9rem] py-2',
  ),
  capabilityChip:
    'inline-flex min-w-0 max-w-full items-center gap-[0.3rem] rounded-full bg-brand-soft px-[0.65rem] py-[0.3rem] text-[0.75rem] font-bold text-brand-primary [overflow-wrap:anywhere]',
  capabilityRemove: 'shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[0.75rem] leading-none text-brand-primary',
  capabilityInput: 'min-w-32 flex-1 border-0 bg-transparent text-[0.85rem] text-ink placeholder:text-ink-muted focus:outline-0',
  counter: 'self-end text-[0.72rem] text-ink-muted tabular-nums',
  capabilityTextarea: classes(
    'min-h-24 w-full resize-y rounded-[1rem] border border-line bg-white px-[0.9rem] py-[0.8rem]',
    'text-[0.85rem] leading-[1.6] text-ink placeholder:text-ink-muted',
    'focus:border-brand-primary focus:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)] focus:outline-0',
  ),
  capabilityHint: 'text-[0.72rem] leading-[1.5] text-ink-muted',
  statusRow:
    'flex items-center justify-between gap-4 rounded-[0.85rem] bg-[#f6f7f8] px-[0.85rem] py-[0.7rem] text-[0.85rem] text-ink',
  accountRow:
    'flex items-center justify-between gap-4 rounded-[0.85rem] bg-[#f6f7f8] px-[0.85rem] py-[0.7rem]',
  accountLabel: 'block text-[0.7rem] font-bold text-ink-muted',
  accountValue: 'block text-[0.85rem] text-ink',
  dangerRow: 'flex justify-end',
  usageList: 'flex flex-col gap-[0.85rem]',
  usageItem: 'flex items-start gap-[0.7rem]',
  usageIcon: 'grid size-8 shrink-0 place-items-center rounded-[0.55rem] bg-brand-soft text-brand-primary',
  usageTitle: 'block text-[0.85rem] font-bold text-ink',
  usageDescription: 'mt-[0.1rem] block text-[0.75rem] leading-[1.5] text-ink-muted',
  publicityTable:
    'w-full border-separate border-spacing-0 overflow-hidden rounded-[1.4rem] border border-line text-[0.72rem]',
  publicityHeadCell:
    'bg-[#f6f7f8] px-[0.7rem] py-[0.55rem] text-left font-bold whitespace-nowrap text-ink',
  publicityCell: 'border-t border-line px-[0.7rem] py-[0.55rem] text-ink-muted',
  publicOpen: 'border-t border-line px-[0.7rem] py-[0.55rem] font-bold text-brand-primary',
  publicClosed: 'border-t border-line px-[0.7rem] py-[0.55rem] text-ink-muted',
  notice: 'm-0 rounded-[0.85rem] bg-brand-soft px-4 py-3 text-[0.8rem] font-semibold text-brand-primary',
  // 불러오는 동안 카드 안을 채우는 막대입니다. 카드 틀은 실제와 같은 것을 씁니다.
  skeletonBar: 'block rounded-md bg-surface-muted motion-safe:animate-pulse',
  // 폼·입력·조회 결과 모양은 온보딩 2단계와 같은 shared/company 스타일을 그대로 씁니다.
  ...companyFormStyles,
  // 완성도 막대 아래 한 줄로 흐르는 체크리스트입니다. 좁으면 줄을 바꿉니다.
  checklist: 'flex flex-wrap gap-x-5 gap-y-[0.45rem] pt-1 text-[0.8rem]',
  checklistItem: 'relative flex items-center gap-[0.55rem]',
  doneMark: 'grid size-[1.125rem] shrink-0 place-items-center rounded-full bg-brand-soft text-ink',
  todoMark: 'size-[1.125rem] shrink-0 rounded-full border border-line bg-white',
  doneLabel: 'text-ink',
  todoLabel: 'text-ink-muted',
} as const

export function companyProfileChoiceClassName(isSelected: boolean) {
  const variant = isSelected
    ? companyProfileStyles.selectedChoice
    : companyProfileStyles.unselectedChoice
  return `${companyProfileStyles.choice} ${variant}`
}
