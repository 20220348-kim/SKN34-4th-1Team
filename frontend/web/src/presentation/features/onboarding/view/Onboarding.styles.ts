/**
 * 온보딩 두 화면(회원 유형·기업 정보)이 함께 쓰는 배치입니다. 웹 화면 v2의 온보딩 2/2 보드를 따릅니다.
 * 머리글이 화면 맨 위에 가로로 놓이고(왼쪽 로고, 가운데 단계 표시), 본문은 그 아래 가운데 열에 들어갑니다.
 * 좁은 화면(600px 미만)은 흰 바탕에 머리글 오른쪽이 "2 / 2 기업 정보" 글자로 바뀌고 버튼 줄이 아래에 고정됩니다.
 */
export const onboardingStyles = {
  page: 'flex min-h-dvh flex-col bg-app-canvas text-app-ink max-[599px]:bg-surface',
  header: 'grid h-[72px] shrink-0 grid-cols-[1fr_auto_1fr] items-center px-10 max-[599px]:flex max-[599px]:h-14 max-[599px]:justify-between max-[599px]:border-b max-[599px]:border-line max-[599px]:px-5',
  brand: 'flex items-center gap-2 text-[1.0625rem] font-bold text-app-ink no-underline',
  brandMark: 'grid size-7 place-items-center rounded-lg bg-brand-primary text-[0.875rem] font-extrabold text-white',
  // 단계 표시입니다. 끝난 단계는 연한 초록 원에 체크, 지금 단계는 초록 원에 번호, 남은 단계는 회색 원입니다.
  steps: 'm-0 flex list-none items-center justify-center gap-3 p-0 max-[599px]:hidden',
  step: 'flex items-center gap-2 text-[0.875rem] font-medium text-ink-muted',
  stepOn: 'font-bold text-app-ink',
  stepMark: 'grid size-[22px] place-items-center rounded-full text-[0.75rem] font-bold',
  stepMarkDone: 'bg-brand-soft text-brand-primary',
  stepMarkOn: 'bg-brand-primary text-white',
  stepMarkIdle: 'bg-line text-ink-muted',
  stepLine: 'h-px w-10 bg-line-strong',
  stepsMobile: 'hidden text-[0.875rem] font-semibold text-ink-muted max-[599px]:inline',
  stepsMobileNumber: 'text-brand-primary',
  headerEnd: 'max-[599px]:hidden',
  // 본문 열입니다. 기업 정보는 640px, 회원 유형 카드 두 장은 800px입니다.
  body: 'mx-auto flex w-full flex-col gap-6 px-5 pt-10 pb-10 max-[599px]:gap-5 max-[599px]:pt-6 max-[599px]:pb-32',
  bodyNarrow: 'max-w-[680px]',
  bodyWide: 'max-w-[840px]',
  heading: 'flex flex-col gap-2',
  eyebrow: 'text-[0.8125rem] font-semibold text-brand-primary',
  title: 'm-0 text-[1.75rem] font-bold tracking-[-0.02em] text-app-ink text-balance max-[599px]:text-[1.375rem]',
  lead: 'm-0 text-[0.9375rem] leading-[1.6] text-ink-muted',
  // 회원 유형 카드(1단계)입니다.
  choices: 'grid w-full grid-cols-2 gap-3 max-[599px]:grid-cols-1',
  choice: [
    'relative flex min-h-[168px] cursor-pointer flex-col gap-2 rounded-[18px] border-[1.5px] border-line bg-surface px-4 pt-[18px] pb-4 transition-[border-color,box-shadow]',
    'hover:border-line-strong has-[:checked]:border-brand-primary has-[:checked]:shadow-focus has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px] has-[:focus-visible]:outline-brand-primary',
    'max-[599px]:grid max-[599px]:min-h-0 max-[599px]:grid-cols-[auto_1fr] max-[599px]:items-start max-[599px]:gap-x-3 max-[599px]:gap-y-1 max-[599px]:px-3.5 max-[599px]:pt-3.5 max-[599px]:pb-3',
  ].join(' '),
  icon: 'grid size-[38px] place-items-center rounded-[11px] bg-brand-soft text-brand-primary max-[599px]:row-span-2 max-[599px]:size-[34px]',
  dot: 'absolute top-4 right-4 size-5 rounded-full border-[1.5px]',
  dotIdle: 'border-line-strong',
  dotOn: 'border-brand-primary bg-brand-primary shadow-[inset_0_0_0_4px_#fff]',
  choiceTitle: 'pr-[26px] text-[0.97rem] font-extrabold text-app-ink',
  choiceDescription: 'text-[0.81rem] leading-[1.55] text-ink-muted',
  gets: 'mt-auto flex flex-col gap-0.5 border-t border-dashed border-line pt-2.5 text-[0.72rem] text-ink-muted max-[599px]:col-span-full',
  getsLead: 'font-extrabold text-brand-primary',
  hint: 'flex w-full items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[0.78rem] text-ink-muted',
  hintIcon: 'mt-0.5 shrink-0 text-info',
  // 기업 정보(2단계) 카드입니다. 번호 조회·결과·입력 칸이 위에서 아래로 열립니다. 좁은 화면은 카드 없이 흰 바탕에 바로 놓입니다.
  card: 'flex w-full flex-col gap-[22px] rounded-[20px] bg-surface px-8 py-7 @container/column max-[599px]:gap-5 max-[599px]:rounded-none max-[599px]:p-0',
  // 조회가 안 될 때의 안내 카드입니다. 다시 시도와 건너뛰기를 함께 둡니다.
  unavailable: 'flex flex-col gap-2 rounded-[14px] border border-info-line bg-info-soft px-[18px] py-4',
  unavailableTitle: 'text-[0.95rem] font-bold text-app-ink',
  unavailableBody: 'text-[0.8125rem] leading-[1.55] text-ink-muted',
  unavailableActions: 'flex flex-wrap gap-2 pt-1',
  // 버튼 줄입니다. 넓은 화면은 본문 오른쪽 끝, 좁은 화면은 아래 고정에 흰 바탕과 윗선.
  foot: 'flex w-full flex-wrap items-center justify-end gap-2 max-[599px]:fixed max-[599px]:inset-x-0 max-[599px]:bottom-0 max-[599px]:z-10 max-[599px]:border-t max-[599px]:border-line max-[599px]:bg-surface max-[599px]:px-5 max-[599px]:pt-3 max-[599px]:pb-[calc(1.75rem+env(safe-area-inset-bottom))]',
  error: 'w-full text-[0.8125rem] font-semibold text-danger',
  primary: 'inline-flex h-11 cursor-pointer items-center justify-center rounded-full border-0 bg-brand-primary px-6 text-[0.9375rem] font-semibold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50 max-[599px]:h-[52px] max-[599px]:flex-[2] max-[599px]:text-base',
  quiet: 'inline-flex h-11 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent px-5 text-[0.9375rem] font-semibold text-ink-muted hover:text-app-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50 max-[599px]:h-[52px] max-[599px]:flex-1 max-[599px]:border max-[599px]:border-line-strong max-[599px]:bg-surface max-[599px]:text-base',
  secondarySmall: 'inline-flex h-9 cursor-pointer items-center justify-center rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] font-semibold text-app-ink hover:border-brand-primary hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
} as const
