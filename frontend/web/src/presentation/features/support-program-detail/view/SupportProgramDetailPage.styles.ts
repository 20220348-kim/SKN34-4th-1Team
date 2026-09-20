function classes(...groups: string[]) {
  return groups.join(' ')
}

export const supportProgramDetailStyles = {
  page: 'mx-auto w-[min(920px,calc(100%_-_2rem))] py-[clamp(1.5rem,5vw,4rem)] [overflow-wrap:anywhere]',
  unavailablePage: 'mx-auto w-[min(720px,calc(100%_-_2rem))] py-[clamp(1.5rem,5vw,4rem)]',
  header: 'mb-8 flex flex-wrap items-center justify-between gap-4',
  headerActions: 'flex flex-wrap items-center gap-3',
  // 관심 공고 저장은 책갈피 아이콘 하나로 둡니다. 담긴 상태는 브랜드색으로 채웁니다.
  saveIconButton: classes(
    'inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-sample-border bg-white text-app-ink',
    'hover:border-brand-primary hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:border-brand-primary aria-pressed:bg-brand-primary aria-pressed:text-white aria-pressed:hover:text-white',
  ),
  // 담기·빼기 결과 안내입니다. 잠깐 보이고 닫을 수 있습니다.
  saveNotice: 'mb-4 flex items-center justify-between gap-3 rounded-[1rem] border border-brand-primary/30 bg-brand-accent px-4 py-3 text-[0.85rem] text-app-ink',
  // 신청 준비 중인 공고를 뺄 때 받는 확인입니다. 결과 안내와 구분되도록 주의색을 씁니다.
  removeConfirm: 'mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[1rem] border border-[#e0b04a] bg-[#fffaf0] px-4 py-3 text-[0.85rem] text-app-ink',
  backLink: classes(
    'inline-flex items-center rounded-full border px-[0.85rem] py-[0.65rem]',
    'border-sample-border bg-white text-[0.85rem] font-bold text-app-ink no-underline',
    'hover:border-brand-primary hover:bg-[#f6f7f8] hover:text-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  sourceBadge: 'rounded-full bg-brand-accent px-3 py-[0.45rem] text-[0.72rem] font-extrabold text-[#066538]',
  hero: classes(
    'mb-6 grid grid-cols-[minmax(0,1fr)_minmax(160px,200px)] items-start gap-6 rounded-[1.4rem] border border-sample-border',
    'bg-white p-[clamp(1.4rem,4vw,2.5rem)] shadow-[0_16px_42px_rgb(32_33_36_/_5%)]',
    'max-chat:grid-cols-1',
  ),
  eyebrow:
    'mt-0 mb-2 text-[0.72rem] font-extrabold tracking-[0.12em] text-sample-muted uppercase',
  title: 'm-0 text-[clamp(1.65rem,4vw,2.45rem)] font-bold leading-[1.25] tracking-[-0.045em] text-app-ink',
  organization: 'mt-3 mb-0 text-[0.9rem] font-bold text-sample-muted',
  summary: 'mt-5 mb-0 leading-[1.7] text-sample-muted',
  qualificationNotice: 'mt-3 mb-4 leading-[1.6] text-sample-muted',
  statusCard: 'grid gap-2 rounded-[1rem] border border-sample-border bg-[#f6f7f8] p-5 text-left',
  statusLabel: 'text-[0.72rem] font-extrabold tracking-[0.08em] text-sample-muted uppercase',
  statusValue: 'text-[1.2rem] text-app-ink',
  score: 'mt-1 w-fit rounded-full bg-brand-accent px-2 py-1 text-[0.72rem] font-extrabold text-brand-primary',
  details: 'grid grid-cols-2 gap-3 max-chat:grid-cols-1',
  detailItem: 'rounded-[1.4rem] border border-sample-border bg-white p-5',
  detailLabel: 'mt-0 mb-3 text-[0.75rem] font-extrabold tracking-[0.08em] text-sample-muted uppercase',
  detailValue: 'leading-[1.6] text-app-ink',
  tagList: 'm-0 flex list-none flex-wrap gap-2 p-0',
  tag: 'rounded-full bg-brand-accent px-3 py-1 text-[0.78rem] font-bold text-[#066538]',
  emptyValue: 'text-sample-muted',
  reasonSection: 'mt-6 rounded-[1.4rem] border border-sample-border bg-white p-[clamp(1.4rem,4vw,2.1rem)]',
  sectionEyebrow:
    'mt-0 mb-2 text-[0.72rem] font-extrabold tracking-[0.12em] text-sample-muted uppercase',
  sectionTitle: 'm-0 text-[1.25rem] font-bold tracking-[-0.03em] text-app-ink',
  reasonList: 'mt-5 mb-0 grid list-none gap-2 p-0',
  reason: 'rounded-[1rem] bg-[#f6f7f8] px-4 py-3 text-[0.88rem] text-app-ink',
  questionSection: 'mt-6 rounded-[1.4rem] border border-sample-border bg-white p-[clamp(1.4rem,4vw,2.1rem)]',
  questionDescription: 'mt-3 mb-0 leading-[1.6] text-sample-muted',
  /** 질문하기·신청 문서 작성하기 버튼을 가운데 정렬하고 사이를 띄웁니다. 좁은 화면에서는 줄을 바꿉니다. */
  questionActions: 'mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-3',
  questionLink: classes(
    'inline-flex rounded-full bg-brand-primary px-4 py-3 text-[0.84rem] font-extrabold text-white no-underline',
    'hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  sourceSection: classes(
    'mt-6 flex items-center justify-between gap-6 rounded-[1.4rem] border border-sample-border bg-white p-[clamp(1.4rem,4vw,2.1rem)]',
    'text-app-ink max-chat:items-start max-chat:flex-col',
  ),
  sourceEyebrow:
    'mt-0 mb-2 text-[0.72rem] font-extrabold tracking-[0.12em] text-sample-muted uppercase',
  sourceTitle: 'm-0 text-[1.25rem] font-bold tracking-[-0.03em] text-app-ink',
  sourceDescription: 'mt-3 mb-0 leading-[1.6] text-sample-muted',
  sourceLink: classes(
    'max-w-full shrink-0 rounded-full bg-brand-primary px-4 py-3 text-[0.84rem] font-extrabold',
    'text-white no-underline hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  unavailableCard: 'mt-6 rounded-[1.4rem] border border-sample-border bg-white p-[clamp(1.5rem,5vw,3rem)] shadow-[0_16px_42px_rgb(32_33_36_/_5%)]',
  unavailableDescription: 'mt-4 mb-0 leading-[1.65] text-sample-muted',
  retryButton: 'mt-5 cursor-pointer rounded-full border-0 bg-brand-primary px-4 py-3 text-[0.84rem] font-extrabold text-white hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
} as const
