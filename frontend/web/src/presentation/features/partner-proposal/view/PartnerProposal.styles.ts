function classes(...groups: string[]) {
  return groups.join(' ')
}

// 색상이나 CSS 속성이 아니라 제안함 화면에서 맡는 UI 역할을 이름으로 사용합니다.
// 카드·태그·버튼은 shared/workspace의 공용 스타일을 쓰고 여기서는 제안함 고유 배치만 다룹니다.
export const partnerProposalStyles = {
  boxTabs: 'flex flex-wrap items-center gap-2',
  list: 'flex flex-col gap-4',
  cardHeader: 'flex flex-wrap items-start justify-between gap-3',
  recruitmentLink: 'text-[0.78rem] font-bold text-brand-primary no-underline hover:underline',
  counterpartRow: 'flex items-center gap-2 rounded-[0.85rem] bg-[#f6f7f8] px-3 py-[0.6rem]',
  counterpartAvatar:
    'grid size-8 shrink-0 place-items-center rounded-[0.5rem] bg-brand-primary text-[0.8rem] font-extrabold text-white',
  counterpartName: 'block text-[0.85rem] font-bold text-app-ink',
  counterpartSummary: 'mt-[0.05rem] block text-[0.7rem] text-sample-muted',
  message: classes(
    'm-0 whitespace-pre-line rounded-[0.85rem] border border-sample-border bg-white px-4 py-3',
    'text-[0.85rem] leading-[1.65] text-app-ink',
  ),
  meta: 'flex flex-wrap gap-x-4 gap-y-1 text-[0.72rem] text-sample-muted',
  actions: 'flex flex-wrap items-center gap-2',
  confirmBox: classes(
    'flex flex-col gap-3 rounded-[0.85rem] border border-brand-primary bg-[#e7f6ed] px-4 py-3',
    'text-[0.82rem] leading-[1.6] text-app-ink',
  ),
  contactCard: 'flex flex-col gap-1 rounded-[0.85rem] bg-[#e7f6ed] px-4 py-3 text-[0.82rem] text-app-ink',
  contactLabel: 'text-[0.7rem] font-extrabold tracking-[0.06em] text-[#087f46] uppercase',
  contactLink: 'font-bold text-brand-primary no-underline hover:underline [overflow-wrap:anywhere]',
  tagRow: 'flex flex-wrap gap-[0.35rem]',
} as const
