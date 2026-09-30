const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'

export const applicationPreparationStyles = {
  form: 'flex flex-col gap-5',
  card: 'flex flex-col gap-3 rounded-[1.4rem] border border-sample-border bg-white p-[1.35rem] shadow-[0_8px_24px_rgb(32_33_36_/_4%)]',
  cardTitle: 'm-0 text-[1.02rem] font-bold tracking-[-0.025em] text-app-ink',
  // 온라인 신청 입력 도우미의 접힌 칸(<details>). 펼치면 제목 줄 아래로 도우미 내용이 이어집니다.
  guide: 'rounded-[1.4rem] border border-sample-border bg-white p-[1.35rem] shadow-[0_8px_24px_rgb(32_33_36_/_4%)] [&>:not(summary)]:mt-3',
  guideSummary: `flex cursor-pointer list-none items-start gap-3 rounded-lg [&::-webkit-details-marker]:hidden ${focus}`,
  guideChevron: 'mt-1 shrink-0 text-ink-muted transition-transform motion-reduce:transition-none [details[open]>summary>&]:rotate-180',
  jobList: 'grid gap-3',
  jobItem: 'flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between',
  jobTitle: 'block break-words text-sm font-bold leading-6 text-app-ink',
  jobMeta: 'mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-slate-600',
  jobStatus: 'rounded-full border border-slate-200 bg-white px-2.5 py-0.5 font-semibold text-slate-700',
  muted: 'text-sm leading-6 text-slate-600',
  label: 'text-sm font-bold text-app-ink',
  input: 'block min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus-visible:border-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087f46] disabled:cursor-not-allowed disabled:bg-slate-100',
  button: 'inline-flex min-h-10 items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087f46]',
  primary: 'inline-flex min-h-11 items-center justify-center self-start rounded-full bg-brand-primary px-5 py-2 text-sm font-semibold text-white hover:bg-[#066538] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087f46]',
  danger: 'inline-flex min-h-10 items-center justify-center rounded-full border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700',
  steps: 'grid grid-cols-2 overflow-hidden rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-slate-500',
  activeStep: 'bg-brand-primary px-4 py-3 text-center text-white',
  inactiveStep: 'px-4 py-3 text-center',
  warning: 'rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950',
  notice: 'rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700',
  status: 'm-0 text-sm leading-6 text-slate-600',
  list: 'flex flex-col gap-3',
  listLink: 'flex flex-col gap-1 rounded-lg text-app-ink no-underline hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#087f46]',
  moreActions: 'flex flex-wrap items-center gap-3',
  officialLink: 'self-start rounded text-sm font-bold text-emerald-800 underline underline-offset-2 hover:text-emerald-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087f46]',
  details: 'grid gap-2 text-sm [&>div]:grid [&>div]:grid-cols-[minmax(7rem,0.3fr)_1fr] [&>div]:gap-3 [&_dt]:font-bold [&_dt]:text-slate-600 [&_dd]:m-0 [&_dd]:text-app-ink',
  sectionList: 'flex flex-col gap-3',
  sectionItem: 'flex flex-col gap-2 rounded-xl border border-slate-200 p-4',
  sectionHeading: 'flex flex-wrap items-center justify-between gap-2',
  notStarted: 'rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600',
  inProgress: 'rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900',
  confirmed: 'rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-900',
  textarea: 'block min-h-28 w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm leading-6 focus-visible:border-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087f46] disabled:cursor-not-allowed disabled:bg-slate-100',
  fieldList: 'grid gap-2 sm:grid-cols-2',
  factItem: 'rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-sm leading-6',
  suggestion: 'flex flex-col gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3',
  checkboxLabel: 'flex items-start gap-2 text-sm font-bold text-slate-900',
  quote: 'm-0 border-l-2 border-sky-300 pl-3 text-xs leading-5 text-slate-600',
  // 답변 입력(25)·초안(26) 본문 첫 줄 "공고명 · 양식명 · 신청 분야". 관심 공고함 lede와 같은 글자이고, PC는 한 줄로 줄이며 600px 미만은 줄바꿈합니다.
  lede: 'm-0 -mt-2 truncate text-[0.8125rem] leading-[1.6] text-sample-muted max-[599px]:whitespace-normal max-[599px]:[overflow-wrap:anywhere]',
  ledeProgram: 'font-bold text-app-ink',
  // 불러오는 동안 lede 자리를 같은 높이(0.8125rem × 1.6)로 채워 아래 내용이 밀리지 않게 합니다.
  ledeSkeleton: '-mt-2 h-[1.3rem] w-2/3 max-w-[32rem] rounded-md bg-surface-muted motion-safe:animate-pulse',
  cardGrid: 'grid gap-3 md:grid-cols-2 xl:grid-cols-3',
  listCard: 'flex min-w-0 flex-col gap-3 rounded-[1.4rem] border border-sample-border bg-white p-[1.15rem]',
  listTitle: 'line-clamp-2 text-[0.95rem] font-bold leading-6',
  listMeta: 'truncate text-[0.8125rem] leading-5 text-ink-muted',
  badgeRow: 'flex flex-wrap items-center gap-2 text-xs font-semibold',
  badgeDone: 'rounded-full bg-emerald-100 px-2.5 py-0.5 text-emerald-900',
  badgeProgress: 'rounded-full bg-info-soft px-2.5 py-0.5 text-info',
  badgeDeadline: 'rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-700',
  badgeUrgent: 'rounded-full bg-amber-100 px-2.5 py-0.5 text-amber-900',
  progressTrack: 'h-1.5 w-full overflow-hidden rounded-full bg-slate-100',
  progressFill: 'h-full rounded-full bg-emerald-600',
  cardFooter: 'mt-auto flex items-center justify-between gap-3',
  cardStamp: 'text-xs leading-5 text-slate-500 tabular-nums',
  cardActions: 'flex shrink-0 items-center gap-1.5',
  secondarySm: `inline-flex min-h-8 items-center justify-center rounded-full border border-slate-300 bg-white px-3 text-[0.8125rem] font-semibold text-app-ink no-underline hover:bg-slate-50 ${focus}`,
  menuButton: `grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border border-line-strong bg-white text-base leading-none text-ink-muted hover:text-app-ink ${focus}`,
  menuItemDanger: 'text-red-800 hover:bg-red-50',
  dangerSolid: `inline-flex min-h-10 items-center justify-center rounded-full bg-[#9a3947] px-4 py-2 text-sm font-semibold text-white hover:bg-[#7f2d39] disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  stepBar: 'sticky bottom-0 flex flex-wrap items-center justify-end gap-2 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-[0_-4px_16px_rgba(15,23,42,0.06)] backdrop-blur',
  skeleton: 'min-h-44 animate-pulse rounded-[1.4rem] border border-slate-100 bg-slate-100',
} as const

/**
 * 답변 입력 화면(25)의 배치입니다. PC는 왼쪽 260px 항목 목록 + 오른쪽 질문 1개, 600px 미만은 목록을 숨기고 진행 막대와
 * 항목 시트로 대신합니다. 이동은 PC에서 질문 카드 바닥 줄, 600px 미만에서 내용 폭의 아래 고정 바로 합니다.
 */
export const answerEditorStyles = {
  // AI 추출 안내(info Alert). 공식 첨부에서 AI가 뽑은 문항일 때만 보이고, 원문 링크를 오른쪽에 둡니다.
  infoAlert: 'flex flex-wrap items-start gap-x-4 gap-y-2 rounded-2xl border border-info-line bg-info-soft px-4 py-3 text-[0.8125rem] leading-[1.6] text-app-ink',
  infoText: 'min-w-0 flex-1',
  infoTitle: 'block text-sm font-bold',
  infoLink: `shrink-0 self-center rounded text-[0.8125rem] font-bold text-info no-underline hover:underline ${focus}`,
  // 자동 저장 실패 · 버전 충돌 알림. 질문 카드 위에 붙습니다.
  dangerAlert: 'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-danger-line bg-danger-soft px-4 py-3 text-[0.8125rem] leading-[1.6] text-app-ink',
  dangerText: 'min-w-0 flex-1',
  retryButton: `inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line-strong bg-white px-3 text-[0.75rem] font-bold text-app-ink hover:border-brand-primary hover:text-brand-primary ${focus}`,
  layout: 'grid items-start gap-5 grid-cols-[260px_minmax(0,1fr)] max-[599px]:grid-cols-1',
  // 왼쪽 항목 목록. PC(600px 이상)에서만 보이고 스크롤해도 따라옵니다. 600px 미만은 시트 안에 같은 내용을 그립니다.
  // 같은 스크롤 칸의 머리글(WorkspacePageHeader, sticky top 0 · 부제 없이 약 89px)이 --workspace-header-h로 알려 주는 높이만큼
  // 내려 붙어야 목록이 머리글 밑으로 들어가지 않습니다. 변수가 아직 없을 때는 89px(5.5625rem)로 둡니다.
  // 목록이 화면보다 길면 머리글과 위아래 여백을 뺀 높이 안에서 스크롤합니다.
  aside: 'flex min-w-0 flex-col gap-3 self-start max-[599px]:hidden min-[600px]:sticky min-[600px]:top-[calc(var(--workspace-header-h,5.5625rem)_+_1rem)] min-[600px]:max-h-[calc(100dvh_-_var(--workspace-header-h,5.5625rem)_-_2rem)] min-[600px]:overflow-y-auto',
  // 전체 답변 막대 카드.
  meterCard: 'flex flex-col gap-2 rounded-2xl border border-line bg-white p-3.5',
  progress: 'flex flex-col gap-1.5',
  progressLabel: 'm-0 flex items-center justify-between text-[0.78rem] font-bold text-ink-muted',
  progressPercent: 'text-brand-primary tabular-nums',
  progressBar: 'h-1.5 overflow-hidden rounded-full bg-surface-muted',
  progressFill: 'block h-full rounded-full bg-brand-primary transition-[width] motion-reduce:transition-none',
  remaining: 'm-0 text-[0.75rem] text-ink-muted',
  sectionList: 'm-0 flex list-none flex-col gap-1 rounded-2xl border border-line bg-white p-1.5',
  sectionButton: `flex w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent px-2 py-2 text-left hover:bg-surface-muted aria-[current=step]:bg-brand-soft ${focus}`,
  sectionNumber: 'grid size-6 shrink-0 place-items-center rounded-full border border-line-strong bg-white text-[0.7rem] font-extrabold tabular-nums text-ink-muted',
  sectionNumberDone: 'border-brand-primary bg-brand-primary text-white',
  sectionNumberActive: 'border-brand-primary text-brand-primary',
  sectionText: 'flex min-w-0 flex-1 flex-col',
  sectionTitle: 'truncate text-[0.8125rem] font-bold text-app-ink',
  sectionMeta: 'text-[0.72rem] text-ink-muted tabular-nums',
  // 항목 상태 배지: 완료 · 필수 비어 있음(지나온 항목) · 진행 중 · 시작 전.
  badgeDone: 'shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[0.68rem] font-extrabold text-brand-primary',
  badgeWarning: 'shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-[0.68rem] font-extrabold text-warning',
  badgeActive: 'shrink-0 rounded-full bg-info-soft px-2 py-0.5 text-[0.68rem] font-extrabold text-info',
  badgeIdle: 'shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[0.68rem] font-extrabold text-ink-muted',
  // 목록 아래 "검토하고 초안 만들기" 링크. 검토 단계로 가는 보조 동작이라 초록 채움이 아닙니다.
  reviewLink: `inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full border border-line-strong bg-white px-4 text-[0.8125rem] font-bold text-app-ink no-underline hover:border-brand-primary hover:text-brand-primary aria-[current=step]:border-brand-primary aria-[current=step]:text-brand-primary ${focus}`,
  // 600px 미만의 진행 표시: 항목명 + "질문 8 / 34"(전체 기준) + 막대, 바로 아래 자동 저장 상태.
  stepperM: 'flex flex-col gap-1.5',
  stepperMLabel: 'm-0 flex items-center justify-between gap-3 text-sm font-extrabold text-app-ink',
  // 섹션이 바뀐 첫 질문 위의 한 줄 띠("기업 개요 완료 → 바우처 활용 계획"). 다음 질문으로 가면 비웁니다.
  sectionBand: 'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-brand-line bg-brand-soft px-3.5 py-2 text-[0.8125rem] font-bold text-app-ink',
  sectionBandWarning: 'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-warning-line bg-warning-soft px-3.5 py-2 text-[0.8125rem] font-bold text-app-ink',
  sectionBandText: 'm-0 min-w-0 flex-1',
  // 오른쪽 질문 카드.
  question: 'flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-white p-5 max-[599px]:p-4',
  questionHead: 'flex items-center gap-1.5',
  questionEyebrow: 'm-0 min-w-0 flex-1 text-[0.78rem] font-bold text-ink-subtle tabular-nums',
  questionTitle: 'm-0 text-[1.1875rem] leading-[1.4] font-extrabold tracking-[-0.02em] text-app-ink outline-none',
  requiredTag: 'ml-auto shrink-0 rounded-full border border-warning-line px-2 py-0.5 text-[0.68rem] font-extrabold text-warning',
  optionalTag: 'ml-auto shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-[0.68rem] font-extrabold text-ink-muted',
  guidance: 'm-0 text-[0.84rem] leading-[1.65] text-ink-muted',
  textarea: `block min-h-28 w-full resize-y rounded-xl border border-line-strong bg-white px-3 py-2.5 text-[0.9375rem] leading-[1.6] text-app-ink placeholder:text-ink-subtle focus-visible:border-brand-primary aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:bg-surface-muted ${focus} max-[599px]:text-base`,
  counter: 'm-0 text-right text-[0.72rem] text-ink-subtle tabular-nums',
  counterOver: 'text-danger',
  fieldError: 'm-0 text-[0.78rem] font-bold text-danger',
  fieldNote: 'm-0 text-[0.78rem] font-semibold text-warning',
  choiceList: 'flex flex-col gap-2',
  choice: 'flex cursor-pointer items-center gap-3 rounded-xl border border-line-strong px-3 py-2.5 text-[0.9375rem] has-[:checked]:border-brand-primary has-[:checked]:bg-brand-soft has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
  answerActions: 'flex flex-wrap items-center justify-between gap-3',
  undecided: 'flex cursor-pointer items-center gap-2 text-[0.8125rem] font-semibold text-app-ink',
  clearButton: `inline-flex h-8 cursor-pointer items-center justify-center rounded-full border border-line-strong bg-white px-3 text-[0.75rem] font-bold text-app-ink hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  hint: 'm-0 rounded-xl bg-surface-muted px-3 py-2 text-[0.78rem] leading-[1.55] text-ink-muted',
  // PC 질문 카드의 바닥 줄: [← 이전] · 자동 저장 상태 · [다음 →] / 검토 단계의 [초안 만들기].
  cardFooter: 'mt-1 flex items-center gap-3 border-t border-line pt-4',
  footerStatus: 'm-0 min-w-0 flex-1 truncate text-[0.78rem] text-ink-muted',
  // 600px 미만 본문 아래 고정 바. 본문 칸 폭에 맞추고(좌우로 넘치지 않음) 버튼은 1 : 2입니다.
  bar: 'sticky bottom-0 z-[2] flex items-center gap-3 border-t border-line bg-[rgb(245_246_247_/_96%)] pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur',
  barStatusM: 'm-0 text-[0.75rem] text-ink-muted',
  // 검토 단계(?step=review): 비어 있는 필수 질문 요약 · 항목별 줄 · 선택 질문 안내.
  errorSummary: 'flex flex-col gap-2 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-[0.8125rem] leading-[1.6] text-app-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger',
  errorSummaryTitle: 'm-0 text-[0.875rem] font-bold',
  errorList: 'm-0 flex list-none flex-col gap-1 p-0',
  errorLink: `rounded font-bold text-danger underline underline-offset-2 hover:no-underline ${focus}`,
  successNote: 'm-0 rounded-xl border border-brand-line bg-brand-soft px-4 py-3 text-[0.8125rem] font-bold text-brand-primary',
  reviewRows: 'm-0 flex list-none flex-col gap-1 rounded-2xl border border-line p-1.5',
  reviewNote: 'm-0 text-[0.78rem] leading-[1.6] text-ink-muted',
  prevButton: `inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full border border-line-strong bg-white px-4 text-[0.8125rem] font-bold text-app-ink hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-40 ${focus} max-[599px]:h-11 max-[599px]:flex-1`,
  nextButton: `ml-auto inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full border-0 bg-brand-primary px-5 text-[0.8125rem] font-bold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50 ${focus} max-[599px]:h-11 max-[599px]:flex-[2]`,
  // 머리글 오른쪽: [문서 보기](공용 secondaryButton, 600px 미만 숨김) · [⋯ 문서 메뉴] · 600px 미만 [항목 목록].
  iconButton: `grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border border-line-strong bg-white text-ink-muted hover:text-app-ink ${focus}`,
  iconButtonM: 'hidden max-[599px]:grid',
  menu: 'z-30 flex min-w-[220px] flex-col gap-0.5 rounded-xl border border-line bg-white p-1.5 shadow-[0_12px_32px_rgb(32_33_36_/_12%)]',
  menuItem: `flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-[0.8125rem] font-semibold text-app-ink no-underline hover:bg-surface-muted ${focus}`,
  // 600px 미만 항목 목록 시트.
  sheetScrim: 'fixed inset-0 z-[19] cursor-default border-0 bg-black/35 p-0',
  sheet: 'fixed inset-x-0 bottom-0 z-20 flex max-h-[86dvh] flex-col gap-3 overflow-y-auto rounded-t-[22px] bg-white px-4 pt-5 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-12px_32px_rgb(32_33_36_/_12%)] outline-none',
  sheetGrab: 'absolute top-2 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-line-strong',
  sheetHeader: 'flex items-center justify-between gap-3',
  sheetTitle: 'm-0 text-base font-extrabold text-app-ink',
} as const

/**
 * 새 문서 화면(24)입니다. 본문은 다른 작업 화면처럼 내용 폭 전체를 쓰고, 위에서부터 lede · ① 공고 · ② 양식 · 분야 · 내용 끝 동작 줄입니다.
 * 600px 미만은 동작 줄의 [취소] · [작성 시작]을 전체 폭 1 : 2로 나눕니다.
 */
export const newPreparationStyles = {
  // 600px 미만은 본문 아래 여백을 main의 32px과 합쳐 92px로 둬, 끝까지 스크롤하면 동작 줄이 도우미 런처 위로 올라옵니다.
  body: 'flex w-full min-w-0 flex-col gap-4 max-[599px]:pb-[60px]',
  // 번호 붙은 섹션(① 공고 · ② 양식 · 분야). ②는 공고를 고르기 전까지 흐린 제목만 보입니다.
  section: 'flex min-w-0 flex-col gap-3',
  sectionTitle: 'm-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.9375rem] font-extrabold text-app-ink outline-none',
  sectionTitleOff: 'm-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.9375rem] font-extrabold text-ink-subtle outline-none',
  sectionNumber: 'grid size-6 shrink-0 place-items-center rounded-full bg-app-ink text-[0.75rem] font-extrabold text-white tabular-nums',
  sectionNumberOff: 'grid size-6 shrink-0 place-items-center rounded-full bg-line-strong text-[0.75rem] font-extrabold text-white tabular-nums',
  sectionHint: 'text-[0.78rem] font-medium text-ink-muted',
  card: 'flex flex-col gap-2.5 rounded-2xl border border-line bg-white p-5 max-[599px]:p-4',
  cardTitle: 'm-0 text-[0.95rem] font-extrabold tracking-[-0.02em] text-app-ink',
  muted: 'm-0 text-[0.8125rem] leading-[1.6] text-ink-muted',
  subtle: 'm-0 text-[0.78rem] leading-[1.6] text-ink-subtle',
  empty: 'flex flex-col items-center gap-3 py-4 text-center',
  // ① 빈 상태의 둥근 아이콘과 제목입니다.
  emptyIcon: 'grid size-11 place-items-center rounded-full bg-brand-soft text-brand-primary',
  emptyTitle: 'm-0 text-[0.9375rem] font-bold text-app-ink',
  // 가운데 정렬한 버튼 아래에 안내 한 줄을 두는 묶음입니다(양식 없음 카드).
  centeredAction: 'flex flex-col items-center gap-2 py-2 text-center',
  programTitle: 'text-base leading-[1.45] font-bold text-app-ink [overflow-wrap:anywhere]',
  programMeta: 'text-[0.8125rem] text-ink-muted tabular-nums',
  cardFoot: 'flex flex-wrap items-center justify-between gap-2 pt-1',
  sourceLink: `rounded text-[0.78rem] font-bold text-ink-muted no-underline hover:text-app-ink hover:underline ${focus}`,
  skeletonLine: 'h-3.5 rounded-md bg-surface-muted motion-safe:animate-pulse',
  // Alert: 테두리·바탕 색으로 뜻을 나눕니다. 오른쪽에 [다시 시도] 같은 동작 하나를 둘 수 있습니다.
  alert: 'flex flex-wrap items-start gap-x-4 gap-y-2 rounded-2xl border px-4 py-3 text-[0.8125rem] leading-[1.6] text-app-ink',
  alertBrand: 'border-brand-line bg-brand-soft',
  alertInfo: 'border-info-line bg-info-soft',
  alertNeutral: 'border-line bg-surface-muted',
  alertWarning: 'border-warning-line bg-warning-soft',
  alertDanger: 'border-danger-line bg-danger-soft',
  alertText: 'flex min-w-0 flex-1 flex-col gap-0.5 [&>p]:m-0',
  alertTitle: 'text-[0.85rem] font-bold',
  jobList: 'm-0 mt-1.5 flex list-none flex-col gap-1.5 p-0',
  jobItem: 'flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl bg-white/80 px-3 py-2 text-[0.78rem]',
  jobTitle: 'min-w-0 flex-1 font-bold text-app-ink',
  jobMeta: 'text-ink-muted tabular-nums',
  // ② 양식 선택 카드와 신청 분야 칸.
  choiceList: 'm-0 flex min-w-0 flex-col gap-2 border-0 p-0',
  choice: 'flex cursor-pointer items-start gap-3 rounded-xl border border-line-strong px-3.5 py-3 has-[:checked]:border-brand-primary has-[:checked]:bg-brand-soft has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
  radio: 'mt-1 size-4 shrink-0 accent-brand-primary',
  choiceText: 'flex min-w-0 flex-col gap-0.5 text-[0.875rem] font-bold text-app-ink [&>span]:text-[0.78rem] [&>span]:font-normal [&>span]:text-ink-muted',
  field: 'flex w-full max-w-[300px] flex-col gap-1.5 max-[599px]:max-w-none',
  fieldLabel: 'text-[0.75rem] font-bold text-ink-muted',
  select: 'h-10 w-full min-w-0 rounded-xl border border-line-strong bg-white px-3 text-[0.8125rem] font-semibold text-app-ink focus-visible:outline-2 focus-visible:outline-brand-primary disabled:opacity-50',
  summary: 'flex flex-col gap-2 rounded-2xl border border-line bg-surface-muted px-4 py-3',
  warningList: 'm-0 list-disc pl-5 text-[0.78rem] leading-[1.6] text-ink-muted',
  // 요약 상자 안 "양식이 원문과 달라 보이면 [입력칸별로 다시 분석] 유료 AI · 계정당 동시에 3건" 줄입니다.
  reanalysis: 'm-0 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[0.8125rem] text-ink-muted',
  cost: 'text-[0.75rem] text-ink-subtle',
  // 10초 넘는 작업의 진행 카드: 스피너 + 제목 + 경과, 아래 줄 "화면을 나가도 계속돼요".
  progress: 'flex flex-col gap-3 rounded-2xl border border-brand-line bg-white p-5 shadow-[0_8px_24px_rgb(32_33_36_/_6%)] max-[599px]:p-4',
  progressHead: 'flex items-start gap-2.5',
  spinner: 'mt-0.5 size-[18px] shrink-0 rounded-full border-2 border-brand-line border-t-brand-primary motion-safe:animate-spin',
  progressTitle: 'min-w-0 flex-1 text-[0.95rem] leading-[1.4] font-bold text-app-ink',
  progressTime: 'text-[0.78rem] whitespace-nowrap text-ink-muted tabular-nums',
  progressNote: 'm-0 border-t border-line pt-2.5 text-[0.78rem] text-ink-muted',
  // 버튼. lg는 48px, md는 40px, sm은 32px입니다.
  primaryLg: `inline-flex h-12 cursor-pointer items-center justify-center gap-1.5 rounded-full border-0 bg-brand-primary px-6 text-[0.875rem] font-bold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  primary: `inline-flex h-10 cursor-pointer items-center justify-center gap-1 rounded-full border-0 bg-brand-primary px-5 text-[0.8125rem] font-bold text-white no-underline hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  secondary: `inline-flex h-10 cursor-pointer items-center justify-center gap-1 rounded-full border border-line-strong bg-white px-4 text-[0.8125rem] font-bold text-app-ink no-underline hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  secondarySm: `inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full border border-line-strong bg-white px-3 text-[0.75rem] font-bold text-app-ink hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  primarySm: `inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary px-3 text-[0.75rem] font-bold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  // [취소]처럼 물러나는 동작입니다. 회색 글자만 두지 않고 옅은 테두리를 둡니다.
  ghost: `inline-flex h-10 cursor-pointer items-center justify-center rounded-full border border-line bg-transparent px-4 text-[0.8125rem] font-bold text-app-ink no-underline hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50 ${focus}`,
  // 내용 끝 오른쪽의 동작 줄: (못 누르는 이유) · [취소] · [작성 시작]. 600px 미만은 이유를 한 줄 위에 두고
  // 버튼을 전체 폭 1 : 2 격자로 나눕니다(글자 폭과 무관하게 정확히 1 : 2, 높이 44px).
  actions: 'flex flex-wrap items-center justify-end gap-2 pt-1 max-[599px]:grid max-[599px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] max-[599px]:[&>a]:h-11 max-[599px]:[&>button]:h-11',
  actionsReason: 'm-0 mr-auto text-[0.78rem] text-ink-muted max-[599px]:col-span-2 max-[599px]:mr-0',
} as const

/**
 * 신청 문서 초안 화면(26)입니다. 알림 · 진행 카드 · 버튼은 새 문서 화면(24)의 스타일을 함께 쓰고, 여기에는 이 화면에만 있는
 * 단계 목록 · 파일 카드 · 600px 미만 아래 동작 줄을 둡니다. 본문은 읽기 폭(920px)까지만 넓어집니다.
 */
export const documentResultStyles = {
  body: 'flex w-full max-w-[920px] min-w-0 flex-col gap-4',
  headerOnly: 'max-[599px]:hidden',
  // [다시 만들기] 옆 "답변이 바뀜" 배지. 답변이 마지막 문서 뒤에 바뀌어 다시 만들 수 있을 때만 보입니다.
  changedBadge: 'inline-flex h-[22px] items-center rounded-md border border-brand-line bg-white px-[7px] text-[0.72rem] font-bold whitespace-nowrap text-brand-primary',
  buttonSpinner: 'size-3 shrink-0 rounded-full border-[1.5px] border-current border-t-transparent motion-safe:animate-spin',
  // 진행 카드의 서버 단계 목록: 완료(채운 ✓) · 진행 중(브랜드 테두리 + 스피너) · 대기(회색).
  stageList: 'm-0 flex list-none flex-col gap-2 p-0',
  stage: 'flex items-center gap-2.5 text-[0.8125rem] text-ink-subtle',
  stageDone: 'flex items-center gap-2.5 text-[0.8125rem] text-app-ink',
  stageActive: 'flex items-center gap-2.5 text-[0.8125rem] font-bold text-app-ink',
  stageMark: 'grid size-5 shrink-0 place-items-center rounded-full border-2 border-line-strong bg-white',
  stageMarkDone: 'grid size-5 shrink-0 place-items-center rounded-full border-2 border-brand-primary bg-brand-primary text-white',
  stageMarkActive: 'grid size-5 shrink-0 place-items-center rounded-full border-2 border-brand-primary bg-white text-brand-primary',
  alertActions: 'flex flex-wrap items-center gap-2',
  // 실패 카드 아래의 서버 문장입니다. 제목 · 본문은 화면이 실패 코드로 고르고, 서버 문장은 참고로만 작게 둡니다.
  failureDetail: 'text-[0.75rem] leading-[1.6] text-ink-muted',
  // 답변 버전별 문서 묶음과 파일 카드.
  group: 'flex flex-col gap-3',
  groupTitle: 'm-0 flex flex-wrap items-baseline gap-x-1.5 text-[0.95rem] font-extrabold tracking-[-0.02em] text-app-ink',
  groupMeta: 'text-[0.78rem] font-semibold text-ink-muted tabular-nums',
  file: 'flex flex-col gap-3 rounded-2xl border border-line bg-white p-4',
  fileHead: 'flex items-start gap-3',
  format: 'grid h-9 min-w-11 shrink-0 place-items-center rounded-lg bg-info-soft px-1.5 text-[0.7rem] font-extrabold text-info',
  fileText: 'flex min-w-0 flex-1 flex-col gap-0.5',
  fileName: 'm-0 text-[0.875rem] leading-[1.45] font-bold text-app-ink [overflow-wrap:anywhere]',
  fileMeta: 'text-[0.75rem] text-ink-muted tabular-nums',
  // 파일 카드 머리 오른쪽 버튼 자리입니다. 보조 버튼을 하나 더 둘 수 있게 줄로 둡니다.
  fileActions: 'flex shrink-0 flex-wrap items-center justify-end gap-1.5',
  fill: 'flex flex-col gap-1.5',
  fillLabel: 'm-0 text-[0.75rem] font-semibold text-ink-muted tabular-nums',
  unfilled: 'rounded-xl border border-warning-line bg-warning-soft px-3 py-2 text-[0.78rem] leading-[1.6] text-app-ink [&_ul]:m-0 [&_ul]:mt-1.5 [&_ul]:flex [&_ul]:list-none [&_ul]:flex-col [&_ul]:gap-1 [&_ul]:p-0',
  unfilledSummary: `cursor-pointer rounded font-bold text-warning ${focus}`,
  older: 'flex flex-col gap-3',
  olderSummary: `self-start cursor-pointer rounded text-[0.8125rem] font-bold text-ink-muted hover:text-app-ink ${focus}`,
  olderTitle: 'm-0 text-[0.8125rem] font-bold text-ink-muted tabular-nums',
  note: 'm-0 text-[0.78rem] leading-[1.6] text-ink-muted',
  // 600px 미만 본문 맨 아래 동작 줄(고정하지 않음). 버튼은 답변 입력 화면(25) 아래 바와 같은 1 : 2입니다.
  mobileBar: 'hidden flex-col gap-2 border-t border-line pt-3 max-[599px]:flex',
  mobileButtons: 'flex items-center gap-3',
} as const

/** 지원 공고 상태 배지 · D-n 배지 · 출처 배지입니다. 1단계 카드와 공고 고르기 행이 함께 씁니다. */
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
 * 공고 고르기 패널입니다. PC는 오른쪽 400px 옆 패널(화면 높이 전체), 600px 미만은 화면 전체 높이 시트입니다.
 * 뒤 화면을 흐린 배경으로 덮어 지금은 패널에서 고르는 중임을 알리고, 흐린 곳을 누르면 닫힙니다.
 * 600px 미만은 [✕]를 제목 왼쪽에 둡니다.
 */
export const programPickerStyles = {
  overlay: 'fixed inset-0 z-50 bg-black/35',
  panel: 'fixed inset-y-0 right-0 flex w-[400px] max-w-full flex-col border-l border-line bg-white shadow-[-12px_0_32px_rgb(32_33_36_/_12%)] outline-none max-[599px]:inset-x-0 max-[599px]:h-dvh max-[599px]:w-full max-[599px]:border-l-0 max-[599px]:shadow-none',
  header: 'flex items-start gap-3 border-b border-line px-5 pt-5 pb-4 max-[599px]:items-center max-[599px]:gap-1 max-[599px]:px-3 max-[599px]:pt-3 max-[599px]:pb-2',
  headerText: 'flex min-w-0 flex-1 flex-col gap-0.5',
  title: 'm-0 text-base font-extrabold text-app-ink',
  sub: 'm-0 text-[0.78rem] text-ink-muted',
  close: `grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-base text-ink-muted hover:bg-surface-muted hover:text-app-ink ${focus} max-[599px]:order-first max-[599px]:size-10 max-[599px]:text-lg max-[599px]:text-app-ink`,
  body: 'flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 max-[599px]:px-4',
  // 관심 공고함 · 전체 검색 세그먼트. 패널 안쪽 폭을 넘지 않고 두 탭이 폭을 반씩 나눕니다(글자가 길면 줄바꿈).
  segment: 'flex w-full min-w-0 max-w-full shrink-0 gap-[3px] rounded-full bg-surface-muted p-[3px]',
  segmentTab: `flex min-h-[34px] min-w-0 flex-[1_1_0] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent px-2 py-1 text-center text-[0.8125rem] leading-[1.3] font-bold text-ink-muted hover:text-app-ink aria-selected:bg-white aria-selected:text-app-ink aria-selected:shadow-[0_1px_3px_rgb(32_33_36_/_12%)] ${focus} max-[599px]:min-h-[38px]`,
  tabPanel: 'flex min-w-0 flex-col gap-3',
  searchRow: 'flex gap-2',
  searchInput: `h-10 min-w-0 flex-1 rounded-xl border border-line-strong bg-white px-3 text-[0.875rem] text-app-ink placeholder:text-ink-subtle focus-visible:border-brand-primary ${focus} max-[599px]:text-base`,
  filterToggle: `inline-flex h-8 cursor-pointer items-center gap-1 self-start rounded-full border border-line-strong bg-white px-3 text-[0.75rem] font-bold text-app-ink hover:border-brand-primary aria-expanded:border-brand-primary aria-expanded:text-brand-primary ${focus}`,
  filters: 'grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface-muted p-3',
  filterField: 'flex min-w-0 flex-col gap-1',
  filterLabel: 'text-[0.72rem] font-bold text-ink-muted',
  multiInput: 'w-full min-w-0 justify-between',
  filterHint: 'col-span-2 m-0 text-[0.72rem] text-ink-muted',
  filterInput: 'h-10 w-full min-w-0 rounded-xl border border-line-strong bg-white px-3 text-[0.8125rem] font-semibold text-app-ink focus-visible:outline-2 focus-visible:outline-brand-primary disabled:opacity-50',
  chips: 'flex flex-wrap items-center gap-1.5',
  chip: `inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-line bg-white px-2.5 text-[0.72rem] font-semibold text-app-ink hover:border-brand-primary ${focus}`,
  resetLink: `ml-auto cursor-pointer rounded border-0 bg-transparent p-0 text-[0.72rem] font-bold text-brand-primary hover:underline ${focus}`,
  count: 'm-0 text-[0.72rem] text-ink-muted tabular-nums',
  list: 'm-0 flex list-none flex-col gap-2 p-0',
  row: 'flex flex-col gap-2 rounded-2xl border border-line bg-white px-3.5 py-3 has-[:checked]:border-brand-primary has-[:checked]:shadow-[0_0_0_3px_rgb(8_127_70_/_14%)]',
  rowLabel: 'flex cursor-pointer items-start gap-2.5',
  radio: 'mt-0.5 size-4 shrink-0 accent-brand-primary',
  rowText: 'flex min-w-0 flex-1 flex-col gap-1',
  rowTitle: 'text-[0.85rem] leading-[1.45] font-bold text-app-ink [overflow-wrap:anywhere]',
  rowMeta: 'text-[0.75rem] text-ink-muted tabular-nums',
  availOk: 'm-0 flex items-center gap-1.5 pl-[26px] text-[0.78rem] font-bold text-brand-primary',
  availNone: 'm-0 flex items-center gap-1.5 pl-[26px] text-[0.78rem] font-bold text-ink-muted',
  availError: 'ml-[26px] flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-danger-line bg-danger-soft px-3 py-2 text-[0.75rem] text-app-ink',
  rowSkeleton: 'h-[76px] rounded-2xl bg-surface-muted motion-safe:animate-pulse',
  state: 'flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-[0.8125rem] text-ink-muted',
  footer: 'flex items-center gap-2 border-t border-line px-5 pt-3 pb-4 max-[599px]:px-4 max-[599px]:pb-[calc(1rem+env(safe-area-inset-bottom))] [&>*:last-child]:flex-1 max-[599px]:[&>*:first-child]:flex-1 max-[599px]:[&>*:last-child]:flex-[2] max-[599px]:[&>button]:h-11',
} as const
