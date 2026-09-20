function classes(...groups: string[]) {
  return groups.join(' ')
}

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'

// 색상이나 CSS 속성이 아니라 관심 공고함에서 맡는 UI 역할을 이름으로 사용합니다.
// 머리글·본문 여백·카드·태그·버튼은 shared/workspace의 공용 스타일을 쓰고, 검색 칸·필터 판은 파트너 모집 목록과 같은 모양입니다.
export const savedCalendarStyles = {
  viewTabs: 'flex flex-wrap items-center gap-2',
  // 검색 칸·선택 상자·적용 조건 띠를 한 카드에 둡니다. 테두리·모서리는 파트너 모집 목록의 필터 판과 같습니다.
  filterPanel: 'overflow-hidden rounded-[1rem] border border-sample-border bg-white',
  filterControls: 'grid grid-cols-[minmax(12rem,1.6fr)_minmax(8rem,0.75fr)_minmax(9rem,0.9fr)_minmax(9rem,0.9fr)] items-end gap-3 p-4 max-[1100px]:grid-cols-2 max-chat:grid-cols-1',
  // 검색 칸도 선택 상자처럼 위에 이름을 두고 아래에 입력 칸을 둡니다.
  searchField: 'grid min-w-0 gap-1 text-[0.7rem] font-bold text-sample-muted',
  search: classes(
    'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[1rem] border border-sample-border bg-white px-[0.9rem]',
    'text-[0.85rem] text-[#838a93] focus-within:border-[#087f46] focus-within:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)]',
  ),
  searchInput: 'min-w-0 flex-1 border-0 bg-transparent text-[0.85rem] text-app-ink outline-0 placeholder:text-sample-muted',
  selectField: classes(
    'grid min-w-0 gap-1 text-[0.7rem] font-bold text-sample-muted',
    '[&>button]:min-h-11 [&>button]:w-full [&>button]:cursor-pointer [&>button]:rounded-[1rem] [&>button]:border [&>button]:border-sample-border [&>button]:bg-white [&>button]:px-3',
    '[&>button]:text-[0.85rem] [&>button]:font-semibold [&>button]:text-app-ink [&>button]:hover:border-[#087f46] [&>button]:focus:outline-0',
    '[&>button]:focus-visible:outline-2 [&>button]:focus-visible:outline-brand-primary',
  ),
  appliedFilters: 'flex min-h-12 flex-wrap items-center gap-2 border-t border-sample-border bg-[#f6f7f8] px-4 py-2 text-[0.78rem] text-sample-muted',
  appliedTitle: 'text-[0.78rem] font-bold text-app-ink',
  filterChip: classes(
    'inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border border-sample-border bg-white px-3 text-[0.74rem] font-semibold text-app-ink',
    'hover:border-[#087f46] hover:text-[#087f46]', focus,
  ),
  resetFilters: `ml-auto cursor-pointer border-0 bg-transparent p-0 text-[0.74rem] font-bold text-[#087f46] hover:text-[#066538] ${focus}`,
  resultCount: 'text-[0.78rem] text-sample-muted',
  // 달력 위 한 줄: 왼쪽에 연·월 선택과 이동 화살표, 화살표 바로 옆에 이 달의 건수. 옅은 선으로 달력과 나눕니다.
  toolbar: 'flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-sample-border pb-4',
  navigation: 'flex min-w-0 flex-wrap items-center gap-3',
  arrowGroup: 'inline-flex shrink-0 overflow-hidden rounded-[0.6rem] border border-sample-border',
  arrow: classes(
    'grid size-9 cursor-pointer place-items-center border-r border-sample-border bg-white text-sample-muted last:border-r-0',
    'hover:bg-brand-accent hover:text-brand-primary disabled:cursor-not-allowed disabled:bg-[#f6f7f8] disabled:text-[#b0b5b9]',
    focus, 'focus-visible:-outline-offset-2',
  ),
  // 연도·월은 브라우저 기본 select를 같은 모양으로 씁니다. 평소엔 테두리 없이 굵은 글씨, 올리면 테두리.
  // `calendar-select`는 index.css에서 펼침 목록을 여섯 줄까지만 보이게 합니다(지원 브라우저에서만).
  monthSelect: classes(
    'calendar-select cursor-pointer rounded-[0.6rem] border border-transparent bg-white py-2 pr-1 text-base font-bold text-app-ink hover:border-sample-border', focus,
  ),
  note: 'text-[0.78rem] text-sample-muted',
  calendarFrame: classes(
    'overflow-x-auto rounded-[1.4rem] border border-sample-border bg-white',
    'shadow-[0_8px_24px_rgb(32_33_36_/_4%)]',
  ),
  table: 'w-full min-w-[760px] table-fixed border-separate border-spacing-0',
  weekday: 'border-b border-sample-border bg-[#f6f7f8] px-3 py-[0.6rem] text-left text-[0.7rem] font-bold',
  cell: 'h-[134px] max-w-0 overflow-hidden border-r border-b border-sample-border px-1.5 py-2 align-top last:border-r-0 [tr:last-child_&]:border-b-0',
  date: 'mb-2 ml-2 inline-flex size-6 items-center justify-center rounded-full text-xs',
  events: 'm-0 flex min-w-0 max-w-full list-none flex-col gap-1 overflow-hidden p-0',
  event: 'flex w-full min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md bg-brand-accent px-1.5 py-1 text-[11px] leading-4 text-[#175d3a]',
  eventBadge: 'mt-px inline-flex min-w-5 shrink-0 items-center justify-center rounded px-1 py-0.5 text-[10px] font-bold leading-none',
  eventTitle: 'block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium',
  overflowCount: `block w-full max-w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded px-1.5 py-0.5 text-left text-[11px] font-semibold text-brand-primary hover:bg-brand-accent hover:underline ${focus}`,
  dialogBackdrop: 'fixed inset-0 z-50 grid place-items-center bg-black/30 p-4',
  dialog: 'flex max-h-[min(680px,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-[1.4rem] border border-sample-border bg-white shadow-2xl',
  dialogHeader: 'flex shrink-0 items-start justify-between gap-4 border-b border-sample-border px-6 py-5',
  dialogClose: `grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-2xl leading-none text-sample-muted hover:bg-[#f1f3f4] hover:text-app-ink ${focus}`,
  dialogEvents: 'm-0 grid list-none gap-2 p-5 pb-3',
  dialogEvent: 'flex min-w-0 items-start gap-2 rounded-xl border border-sample-border bg-white px-3 py-3 leading-relaxed',
  dialogPagination: 'shrink-0 px-5 pb-4',
  // 목록 보기는 파트너 모집과 같은 카드 격자입니다.
  cardGrid: 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,max(300px,calc((100%_-_2rem)/3))),1fr))]',
  cardTop: 'flex items-center justify-between gap-3',
  cardPeriod: 'text-[0.72rem] font-bold text-sample-muted',
  cardTitle: 'm-0 line-clamp-2 text-[1.02rem] font-bold leading-[1.4] tracking-[-0.025em] text-app-ink [overflow-wrap:anywhere]',
  cardTitleLink: 'text-app-ink no-underline hover:text-brand-primary',
  cardMeta: 'm-0 line-clamp-2 text-[0.75rem] leading-[1.5] text-sample-muted',
  tagRow: 'mt-auto flex flex-wrap gap-[0.35rem] pt-1 [&>span]:max-w-full [&>span]:shrink [&>span]:truncate',
  pagination: 'flex flex-wrap items-center justify-center gap-2 pt-2',
  compactPagination: 'mt-auto flex flex-wrap items-center justify-center gap-1 pt-2',
  pageButton: classes(
    'inline-flex min-h-9 min-w-9 cursor-pointer items-center justify-center rounded-full border px-3 text-[0.74rem] font-bold',
    'disabled:cursor-not-allowed disabled:opacity-40', focus,
  ),
  compactPageButton: classes(
    'inline-flex size-6 cursor-pointer items-center justify-center rounded-full border p-0 text-[0.64rem] font-bold',
    'disabled:cursor-not-allowed disabled:opacity-40', focus,
  ),
  inactivePageButton: 'border-sample-border bg-white text-sample-muted hover:border-[#087f46] hover:text-[#087f46]',
  activePageButton: 'border-brand-primary bg-brand-primary text-white',
  footer: 'm-0 text-[0.72rem] leading-relaxed text-sample-muted',
  pipelineSection: 'flex min-w-0 flex-col gap-4 overflow-x-auto',
  // 일곱 단계 보드는 좁은 화면에서 열·카드 내부 텍스트가 잘리지 않도록 최소 폭을 유지하고 가로로 이동합니다.
  pipelineBoard: 'grid min-w-[980px] grid-cols-7 items-stretch gap-2',
  pipelineColumn: 'flex min-h-[360px] min-w-0 flex-col rounded-[1rem] border p-2.5',
  pipelineColumnHeader: 'flex items-center justify-between gap-2',
  pipelineColumnTitle: 'm-0 text-[0.88rem] font-extrabold tracking-[-0.02em] text-app-ink',
  pipelineCount: 'inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-[0.7rem] font-extrabold text-brand-primary shadow-sm',
  pipelineColumnDescription: 'mt-1.5 mb-2 min-h-[3.5rem] text-[0.64rem] leading-[1.45] text-sample-muted [overflow-wrap:anywhere]',
  pipelineCards: 'flex flex-col gap-2 pb-2',
  pipelineEmpty: 'm-0 rounded-xl border border-dashed border-sample-border bg-white/70 px-3 py-5 text-center text-[0.68rem] leading-[1.5] text-sample-muted',
  pipelineColumnMore: `mt-auto w-full cursor-pointer rounded-lg border border-sample-border bg-white px-2 py-2 text-[0.7rem] font-bold text-brand-primary hover:border-brand-primary ${focus}`,
  pipelineCard: 'flex min-w-0 flex-col gap-1.5 rounded-xl border border-sample-border bg-white p-2 shadow-[0_5px_14px_rgb(32_33_36_/_5%)]',
  pipelineCardTop: 'flex min-w-0 flex-wrap items-center justify-between gap-2',
  pipelineRevision: 'shrink-0 text-[0.65rem] font-semibold text-sample-muted',
  pipelineCardTitle: 'm-0 line-clamp-2 text-[0.74rem] font-bold leading-[1.4] tracking-[-0.02em] text-app-ink [overflow-wrap:anywhere]',
  pipelineFormTitle: 'm-0 truncate text-[0.64rem] leading-[1.4] text-sample-muted',
  pipelineUpdatedAt: 'm-0 text-[0.65rem] font-semibold text-sample-muted',
  pipelineCardAction: 'min-h-8 whitespace-nowrap px-2 py-1.5 text-[0.68rem]',
  pipelineStageField: classes(
    'grid gap-1 text-[0.65rem] font-bold text-sample-muted',
    '[&>button]:min-h-9 [&>button]:w-full [&>button]:cursor-pointer [&>button]:rounded-lg [&>button]:border [&>button]:border-sample-border',
    '[&>button]:bg-white [&>button]:px-2 [&>button]:text-[0.72rem] [&>button]:font-semibold [&>button]:text-app-ink',
    '[&>button]:focus-visible:outline-2 [&>button]:focus-visible:outline-brand-primary [&>button]:disabled:cursor-wait [&>button]:disabled:opacity-60',
  ),
  pipelineError: 'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#edc4ca] bg-[#fff5f6] px-4 py-3 text-[0.76rem] font-semibold text-[#9a3947]',
  pipelineMore: 'flex justify-center pt-1',
  pipelineDialog: 'flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-4xl flex-col overflow-hidden rounded-[1.4rem] border border-sample-border bg-white shadow-2xl',
  pipelineDialogCards: 'grid grid-cols-2 gap-3 p-5 pb-3 max-chat:grid-cols-1',
} as const
