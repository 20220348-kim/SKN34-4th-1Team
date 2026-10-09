function classes(...groups: string[]) {
  return groups.join(' ')
}

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'

// 색상이나 CSS 속성이 아니라 리포트 화면에서 맡는 UI 역할을 이름으로 사용합니다.
// 화면 통일안 22: 기준 줄 → 리포트 머리 카드 → 추천 카드 → 면책 문구, 그리고 접힌 수신 설정.
// 다른 작업 화면처럼 머리글 왼쪽 끝에 맞춰 작업 공간 폭을 쓰고, 넓은 화면에서는 모집글 상세처럼 본문 · 오른쪽 340px(수신 설정) 두 열로 둡니다.
export const dailyReportStyles = {
  column: 'flex min-w-0 flex-col gap-4',
  basis: 'm-0 -mt-2 text-[0.8125rem] leading-[1.6] text-ink-muted',
  note: 'm-0 text-[0.78rem] leading-[1.6] text-ink-muted',
  smallButton: classes(
    'inline-flex min-h-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line bg-white px-3.5 text-[0.74rem] font-bold text-ink no-underline',
    'hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-60', focus,
  ),
  smallPrimaryButton: classes(
    'inline-flex min-h-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary px-3.5 text-[0.74rem] font-extrabold text-white',
    'hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60', focus,
  ),
  // 빈 상태 · 오류 · 만드는 중: 가운데 정렬 카드에 제목, 설명, 동작 하나.
  stateCard: 'flex flex-col items-center gap-2 rounded-[1.4rem] border border-dashed border-line-strong bg-white px-5 py-8 text-center',
  stateGlyph: 'grid size-11 place-items-center rounded-full bg-surface-muted text-ink-muted',
  stateGlyphDanger: 'grid size-11 place-items-center rounded-full bg-danger-soft text-danger',
  stateTitle: 'm-0 text-[0.95rem] font-bold text-ink',
  stateText: 'm-0 max-w-[44ch] text-[0.8125rem] leading-[1.6] text-ink-muted',
  spinner: 'size-5 rounded-full border-2 border-line border-t-brand-primary motion-safe:animate-spin',
  // 이전 리포트만 있을 때 맨 위 한 줄: 왼쪽 안내, 오른쪽 [오늘의 리포트 만들기].
  todayRow: 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[1.2rem] border border-line bg-white px-4 py-3',
  todayRowText: 'm-0 text-[0.8125rem] leading-[1.55] text-ink',
  alert: 'm-0 rounded-xl border border-danger-line bg-danger-soft px-3.5 py-2.5 text-[0.8125rem] leading-[1.55] text-danger',
  warning: 'm-0 rounded-xl border border-warning-line bg-warning-soft px-3.5 py-2.5 text-[0.8125rem] leading-[1.55] text-warning',
  // 리포트 머리: 날짜 · 추천 건수 · 생성 시각과 발송 상태 한 줄, 그 아래 기준 조건 한 문장.
  headCard: 'flex flex-col gap-2 rounded-[1.4rem] border border-line bg-white px-[1.35rem] py-5 shadow-[0_8px_24px_rgb(32_33_36_/_4%)]',
  headRow: 'flex flex-wrap items-center gap-x-2 gap-y-1',
  headTitle: 'm-0 text-[1.125rem] font-extrabold tracking-[-0.02em] text-ink',
  headMeta: 'ml-auto text-[0.78rem] tabular-nums text-ink-subtle',
  headSummary: 'm-0 text-[0.875rem] leading-[1.7] text-ink',
  notices: 'm-0 flex list-none flex-col gap-1 rounded-xl bg-surface-muted px-3 py-2.5 text-[0.78rem] leading-[1.55] text-ink-muted',
  // 추천 카드: 배지 줄 → 제목 → 접수 기간 → 매칭 근거 → 접는 조건·서류 → 아래 줄(원문 보기 | 책갈피 · 상세 보기).
  programList: 'flex flex-col gap-3',
  programCard: 'flex min-w-0 flex-col gap-2.5 rounded-[1.2rem] border border-line bg-white p-4',
  programTop: 'flex flex-wrap items-center gap-1.5',
  status: 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.68rem] font-extrabold whitespace-nowrap',
  statusDot: 'size-1.5 rounded-full bg-current',
  dday: 'inline-flex rounded-md px-1.5 py-0.5 text-[0.7rem] font-bold tabular-nums whitespace-nowrap',
  eligibility: 'inline-flex items-center rounded-md border bg-white px-1.5 py-0.5 text-[0.7rem] font-bold whitespace-nowrap',
  relevance: 'ml-auto text-[0.75rem] font-bold tabular-nums text-brand-primary',
  programTitle: 'm-0 text-[0.95rem] font-bold leading-[1.45] [overflow-wrap:anywhere]',
  programTitleLink: `text-ink no-underline hover:underline hover:underline-offset-[3px] ${focus}`,
  programMeta: 'm-0 text-[0.78rem] tabular-nums text-ink-muted',
  reasons: 'm-0 flex list-none flex-wrap gap-x-2.5 gap-y-1 p-0 text-[0.78rem] leading-[1.5] text-ink',
  reasonsLabel: 'font-bold text-ink-muted',
  evidence: 'group rounded-xl border border-line bg-[#f6f7f8]',
  evidenceSummary: classes(
    'flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-[0.8125rem] font-bold text-ink [&::-webkit-details-marker]:hidden', focus,
  ),
  evidenceBadge: 'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[0.7rem] font-bold whitespace-nowrap',
  evidenceChevron: 'shrink-0 text-ink-subtle group-open:rotate-180',
  evidenceBody: 'flex flex-col gap-2 px-3 pb-3',
  evidenceNote: 'm-0 text-[0.78rem] leading-[1.6] whitespace-pre-wrap text-ink-muted',
  evidenceAnswer: 'm-0 text-[0.84rem] leading-[1.7] whitespace-pre-wrap text-ink',
  citations: 'm-0 flex list-none flex-col gap-2 p-0',
  citation: 'flex flex-col gap-1 rounded-xl border border-line bg-white px-3 py-2.5',
  citationQuote: 'm-0 border-l-[3px] border-brand-line pl-2.5 text-[0.8125rem] leading-[1.6] whitespace-pre-wrap text-ink',
  citationLink: `self-start text-[0.74rem] font-bold text-brand-primary no-underline hover:text-brand-hover ${focus}`,
  programFoot: 'flex items-center gap-2 border-t border-line pt-2.5',
  sourceLink: `mr-auto inline-flex items-center gap-1 text-[0.78rem] font-semibold text-ink-muted no-underline hover:text-brand-primary ${focus}`,
  bookmark: classes(
    'grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border border-line bg-white text-ink-muted',
    'hover:border-brand-primary hover:text-brand-primary aria-pressed:border-brand-line aria-pressed:bg-brand-soft aria-pressed:text-brand-primary',
    'disabled:cursor-wait disabled:opacity-50', focus,
  ),
  // 수신 설정: 접힌 머리(아이콘 · 제목 · 요약 한 줄 · ▾)와, 펼치면 받는 방법 | 추천 기준 두 칸. 카드 폭이 좁으면 한 칸으로 쌓습니다.
  // 머리글이 위에 붙어 있으므로 이 카드로 스크롤할 때 머리글 높이만큼 띄웁니다.
  settingsCard: '@container/settings scroll-mt-[calc(var(--workspace-header-h,0px)+1rem)] rounded-[1.2rem] border border-line bg-white',
  settingsHeading: 'm-0',
  settingsToggle: classes(
    'flex min-h-[60px] w-full cursor-pointer items-center gap-3 rounded-[1.2rem] border-0 bg-transparent px-4 py-3 text-left text-ink', focus,
  ),
  settingsIcon: 'grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface-muted text-ink-muted',
  settingsText: 'flex min-w-0 flex-1 flex-col gap-px',
  settingsTitle: 'text-[0.9rem] font-bold',
  settingsSummary: 'text-[0.78rem] font-normal text-ink-subtle [overflow-wrap:anywhere]',
  settingsChevron: 'shrink-0 text-ink-subtle',
  settingsBody: 'flex flex-col gap-4 border-t border-line px-4 pt-4 pb-4',
  form: 'flex flex-col gap-4',
  settingsGrid: 'grid grid-cols-1 items-start gap-x-5 gap-y-4 @min-[40rem]/settings:grid-cols-2',
  settingsGroup: 'flex min-w-0 flex-col gap-2',
  groupTitle: 'm-0 text-[0.78rem] font-bold text-ink-muted',
  // 받는 방법 한 줄: 프로필의 설정 줄과 같은 옅은 회색 상자에 이름 · 설명, 오른쪽 끝에 상태 태그(보기)나 스위치(수정).
  channel: 'flex flex-col gap-2 rounded-[0.85rem] bg-[#f6f7f8] px-4 py-[0.85rem]',
  channelHead: 'flex items-center justify-between gap-4',
  channelText: 'flex min-w-0 flex-col gap-0.5',
  channelTitle: 'text-[0.85rem] font-bold text-ink',
  channelTitleRow: 'flex items-center gap-2',
  channelDescription: 'text-[0.74rem] leading-[1.5] text-ink-muted',
  channelAddress: 'flex flex-wrap items-center gap-x-2 gap-y-1.5',
  addressValue: 'text-[0.84rem] text-ink [overflow-wrap:anywhere]',
  valueBox: 'flex flex-col gap-1 rounded-[0.85rem] bg-[#f6f7f8] px-[0.85rem] py-[0.7rem]',
  emptyValueBox: 'flex flex-col gap-1 rounded-[0.85rem] border border-dashed border-line bg-white px-[0.85rem] py-[0.7rem]',
  valueLabel: 'flex items-center gap-1 text-[0.7rem] font-bold text-ink-muted',
  optionalMark: 'font-semibold text-ink-subtle',
  value: 'text-[0.85rem] text-ink [overflow-wrap:anywhere]',
  emptyValue: 'text-[0.85rem] text-ink-muted',
  field: 'flex flex-col gap-1.5',
  fieldLabel: 'text-[0.78rem] font-bold text-ink',
  input: classes(
    'h-10 w-full rounded-xl border border-line-strong bg-white px-3 text-[0.875rem] text-ink placeholder:text-ink-subtle',
    'focus:border-brand-primary focus:shadow-[0_0_0_3px_rgb(8_127_70_/_14%)] focus:outline-0 disabled:opacity-60 max-chat:text-base',
  ),
  fieldError: 'm-0 text-[0.75rem] font-semibold text-danger',
  consent: 'flex cursor-pointer items-start gap-2 text-[0.8125rem] leading-[1.55] text-ink [&>input]:mt-1 [&>input]:accent-brand-primary',
  // 보기의 [수정]과 수정의 [취소][저장]은 같은 자리(오른쪽 아래)에 둡니다.
  formActions: 'flex items-center justify-end gap-2',
  skeletonBar: 'rounded-md bg-surface-muted motion-safe:animate-pulse',
} as const
