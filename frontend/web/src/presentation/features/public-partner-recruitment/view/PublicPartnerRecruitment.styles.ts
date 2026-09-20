function classes(...groups: string[]) {
  return groups.join(' ')
}

// 색상이나 CSS 속성이 아니라 로그인 전 공개 파트너 모집 화면에서 맡는 UI 역할을 이름으로 사용합니다.
// 태그·버튼처럼 작업 화면과 같은 조각은 shared/workspace의 스타일을 쓰고 여기서는 공개 화면 배치만 다룹니다.
export const publicPartnerRecruitmentStyles = {
  page: classes(
    'mx-auto flex w-[min(1180px,calc(100%_-_3rem))] min-w-0 flex-col gap-10 pt-[clamp(2.5rem,5vw,4rem)] pb-16 text-app-ink',
    'max-chat:w-[calc(100%_-_2rem)] max-chat:gap-8 max-chat:pb-10',
  ),
  hero: 'flex flex-col gap-3',
  title: 'm-0 text-[clamp(1.7rem,3.2vw,2.4rem)] font-extrabold leading-[1.25] tracking-[-0.04em]',
  description: 'm-0 max-w-[62ch] text-[0.95rem] leading-[1.7] text-sample-muted',
  columns: 'grid grid-cols-[minmax(0,1fr)_320px] items-start gap-6 max-chat:grid-cols-1',
  column: 'flex min-w-0 flex-col gap-5',
  // 로그인 뒤 목록의 검색 칸과 같은 모양입니다.
  searchRow: 'flex flex-wrap items-center gap-2',
  search: classes(
    'flex min-h-11 w-[320px] max-w-full items-center gap-2 rounded-[1rem] border border-sample-border bg-white px-[0.9rem]',
    'text-[0.85rem] text-[#838a93] focus-within:border-[#087f46] focus-within:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)]',
  ),
  searchInput: 'min-w-0 flex-1 border-0 bg-transparent text-[0.85rem] text-app-ink outline-0 placeholder:text-sample-muted',
  // 검색 칸·조회 뒤에 "검색 결과 N건"이 이어지고 출처·정렬은 오른쪽 끝에 붙습니다.
  searchBar: 'flex flex-wrap items-center gap-x-4 gap-y-3',
  // 지원사업 찾기 필터 검색의 "검색 결과 N건" 제목·선택 상자와 같은 모양입니다.
  resultCount: 'm-0 text-base font-bold',
  resultTotal: 'text-brand-primary',
  listOptions: 'ml-auto flex flex-wrap items-center gap-3',
  optionLabel: 'flex items-center gap-2 text-xs text-sample-muted',
  optionSelect: classes(
    'min-h-9 w-auto min-w-0 rounded-xl border border-sample-border bg-white px-3 text-xs text-app-ink',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  // 폭에 따라 3열·2열·1열로 저절로 줄어드는 격자입니다. 한 줄은 최대 3열(카드 폭이 전체의 1/3 이상)이고 같은 줄의 카드는 같은 높이로 늘어납니다.
  cardGrid: 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,max(300px,calc((100%_-_2rem)/3))),1fr))]',
  card: classes(
    'flex flex-col gap-[0.9rem] rounded-[1.4rem] border border-sample-border bg-white p-[1.35rem]',
    'shadow-[0_8px_24px_rgb(32_33_36_/_5%)]',
  ),
  cardTop: 'flex items-center justify-between gap-3',
  cardDeadline: 'text-[0.74rem] font-extrabold text-[#b75561]',
  cardTitle: 'm-0 line-clamp-2 text-[1.02rem] font-bold leading-[1.4] tracking-[-0.025em] [overflow-wrap:anywhere]',
  cardProgram: 'm-0 line-clamp-2 text-[0.75rem] leading-[1.5] text-sample-muted',
  // 비로그인 화면의 작성 기업 자리입니다. 실제 값 대신 흐린 자리표시자와 잠금 안내만 그립니다.
  maskedRow: 'relative overflow-hidden rounded-[0.85rem] bg-[#f6f7f8] px-3 py-[0.6rem]',
  maskedSkeleton: 'pointer-events-none flex select-none items-center gap-2 opacity-60 blur-[4px]',
  maskedAvatar: 'block size-7 shrink-0 rounded-[0.5rem] bg-brand-primary',
  maskedLine: 'block h-3 w-28 rounded bg-slate-300',
  maskedLineShort: 'block h-2.5 w-36 rounded bg-slate-200',
  maskedTag: 'ml-auto block h-5 w-14 rounded-full bg-slate-200',
  maskedOverlay: 'absolute inset-0 flex items-center justify-center gap-[0.35rem] bg-white/35 text-[0.72rem] font-bold text-slate-600',
  // 역량처럼 긴 태그는 한 줄 말줄임으로 자르고 전체 문구는 title로 보여 줍니다.
  tagRow: 'flex flex-wrap gap-[0.35rem] [&>span]:max-w-full [&>span]:shrink [&>span]:truncate',
  // 카드 높이가 달라도 하단 줄은 항상 바닥에 붙습니다.
  cardFooter: 'mt-auto flex items-center justify-between gap-3 pt-1',
  cardFooterNote: 'text-[0.72rem] text-sample-muted',
  moreRow: 'flex justify-center pt-2',
  ctaList: 'm-0 flex list-disc flex-col gap-[0.35rem] pl-5 text-[0.8rem] leading-[1.6] text-[#365947]',
  ctaButtons: 'flex flex-col gap-2 pt-1',
  heroActions: 'flex flex-wrap items-center gap-2 pt-1',
  noticeCard: 'flex flex-col gap-[0.6rem] rounded-[1.4rem] border border-sample-border bg-white p-[1.2rem]',
  noticeText: 'm-0 text-[0.78rem] leading-[1.6] text-sample-muted',
  backLink: 'inline-flex w-fit items-center gap-[0.3rem] text-[0.8rem] font-bold text-brand-primary no-underline hover:underline',
  detailTitle: 'm-0 text-[clamp(1.4rem,2.6vw,1.9rem)] font-bold leading-[1.35] tracking-[-0.03em] [overflow-wrap:anywhere]',
  conditionGrid: 'grid grid-cols-3 gap-[0.6rem] max-chat:grid-cols-1',
  conditionCell: 'flex flex-col gap-[0.2rem] rounded-[0.85rem] border border-sample-border px-[0.85rem] py-[0.7rem]',
  conditionLabel: 'text-[0.68rem] font-bold text-sample-muted',
  conditionValue: 'text-[0.85rem] font-bold',
  rawBox: 'flex flex-col gap-1 rounded-[0.85rem] bg-[#f6f7f8] p-[0.7rem] text-[0.75rem] text-[#4d597c]',
  rawBoxLabel: 'font-bold text-app-ink',
  bodyParagraph: 'm-0 text-[0.88rem] leading-[1.7]',
  disclaimer: 'm-0 text-[0.72rem] leading-[1.55] text-sample-muted',
  flowRow: 'flex flex-wrap items-center gap-[0.35rem] text-[0.72rem] font-bold text-[#4d597c]',
  flowStep: 'inline-flex rounded-[0.35rem] border border-sample-border bg-white px-[0.45rem] py-[0.25rem]',
} as const
