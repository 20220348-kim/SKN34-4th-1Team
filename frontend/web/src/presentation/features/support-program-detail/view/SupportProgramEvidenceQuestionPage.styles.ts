function classes(...groups: string[]) {
  return groups.join(' ')
}

export const supportProgramEvidenceQuestionStyles = {
  page: 'mx-auto w-[min(720px,calc(100%_-_2rem))] py-[clamp(1.5rem,5vw,4rem)] [overflow-wrap:anywhere]',
  backLink: classes(
    'inline-flex items-center rounded-full border px-[0.85rem] py-[0.65rem]',
    'border-sample-border bg-white text-[0.85rem] font-bold text-app-ink no-underline',
    'hover:border-brand-primary hover:bg-[#f6f7f8] hover:text-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  title: 'm-0 text-[clamp(1.65rem,4vw,2.45rem)] font-bold leading-[1.25] tracking-[-0.045em] text-app-ink',
  sectionEyebrow:
    'mt-0 mb-2 text-[0.72rem] font-extrabold tracking-[0.12em] text-sample-muted uppercase',
  evidenceSection: 'mt-6 rounded-[1.4rem] border border-sample-border bg-white p-[clamp(1.4rem,4vw,2.1rem)]',
  evidenceHeader: 'flex flex-wrap items-start justify-between gap-4',
  evidenceBadge: 'shrink-0 rounded-full bg-brand-accent px-3 py-[0.45rem] text-[0.7rem] font-extrabold text-brand-primary',
  evidenceDescription: 'mt-3 mb-0 leading-[1.6] text-sample-muted',
  evidenceForm: 'mt-5 grid gap-2',
  evidenceLabel: 'text-[0.82rem] font-extrabold text-app-ink',
  evidenceInput: classes(
    'min-h-24 w-full resize-y rounded-[1rem] border bg-white px-3 py-3 leading-[1.55] text-app-ink placeholder:text-sample-muted outline-0',
    'border-sample-border focus:border-brand-primary focus:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)]',
    'disabled:cursor-wait disabled:bg-[#f6f7f8] disabled:text-sample-muted',
  ),
  evidenceControls: 'mt-1 flex items-center justify-between gap-3',
  evidenceCount: 'text-[0.72rem] text-sample-muted',
  evidenceSubmitButton: classes(
    'cursor-pointer rounded-full border-0 bg-brand-primary px-4 py-[0.7rem] text-[0.78rem] font-extrabold text-white',
    'hover:bg-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-[0.4]',
  ),
  evidenceCancelButton: classes(
    'cursor-pointer rounded-full border border-sample-border bg-white px-4 py-[0.7rem] text-[0.78rem] font-extrabold text-app-ink',
    'hover:border-brand-primary hover:bg-[#f6f7f8] hover:text-[#066538] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  evidenceHint: 'text-[0.7rem] leading-[1.45] text-sample-muted',
  evidenceFeedback: 'mt-5 mb-0 rounded-[1rem] border border-sample-border bg-[#f6f7f8] px-4 py-3 text-[0.84rem] leading-[1.55] text-app-ink',
  evidenceError: 'mt-5 mb-0 rounded-[1rem] border border-[#f0cfd4] bg-[#fff5f6] px-4 py-3 text-[0.84rem] leading-[1.55] text-[#9a3947]',
  evidenceAnswer: 'mt-5 rounded-[1.4rem] border border-sample-border bg-white p-5',
  evidenceAnswerEyebrow: 'mt-0 mb-2 text-[0.7rem] font-extrabold tracking-[0.1em] text-brand-primary uppercase',
  evidenceAnswerText: 'm-0 whitespace-pre-wrap leading-[1.7] text-app-ink',
  evidenceCitationTitle: 'mt-5 mb-3 text-[0.86rem] font-extrabold text-app-ink',
  evidenceCitationList: 'm-0 grid list-decimal gap-3 pl-5',
  evidenceCitation: 'pl-1 text-app-ink',
  evidenceExcerpt: 'm-0 whitespace-pre-wrap rounded-[1rem] bg-white px-4 py-3 text-[0.82rem] leading-[1.6] text-sample-muted',
  evidenceSourceLink: 'mt-2 inline-block rounded-full text-[0.75rem] font-extrabold text-brand-primary no-underline hover:text-[#066538] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  // 공고 상세 안 질문 패널입니다. 답·안내는 패널 폭에 맞춘 촘촘한 판을 씁니다.
  evidenceFeedbackCompact: 'm-0 rounded-[0.85rem] bg-surface-muted px-3.5 py-2.5 text-[0.8125rem] leading-[1.55] text-app-ink',
  evidenceErrorCompact: 'm-0 rounded-[0.85rem] border border-danger-line bg-danger-soft px-3.5 py-2.5 text-[0.8125rem] leading-[1.55] text-danger',
  evidenceAnswerCompact: 'rounded-[0.85rem] border border-line bg-surface px-3.5 py-3 text-[0.875rem]',
  // 공고 상세 위에 겹치는 옆 패널(화면 통일안 17)입니다. 넓은 화면은 오른쪽 400px 세로 패널, 좁은 화면은 아래 시트(최대 86%)입니다.
  panel: classes(
    'fixed inset-y-0 right-0 z-20 flex w-[400px] max-w-full flex-col border-l border-line bg-surface shadow-[-18px_0_40px_rgb(32_33_36_/_12%)]',
    'max-[599px]:inset-x-0 max-[599px]:top-auto max-[599px]:bottom-0 max-[599px]:w-auto max-[599px]:max-h-[86dvh] max-[599px]:rounded-t-[22px] max-[599px]:border-0 max-[599px]:shadow-[0_-12px_32px_rgb(32_33_36_/_12%)]',
  ),
  panelScrim: 'hidden max-[599px]:block max-[599px]:fixed max-[599px]:inset-0 max-[599px]:z-[19] max-[599px]:cursor-default max-[599px]:border-0 max-[599px]:bg-black/35 max-[599px]:p-0',
  panelHeader: 'relative flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 pt-4 pb-3 max-[599px]:pt-5',
  // 좁은 화면의 시트 손잡이입니다.
  panelGrab: 'hidden max-[599px]:block max-[599px]:absolute max-[599px]:top-2 max-[599px]:left-1/2 max-[599px]:h-1 max-[599px]:w-9 max-[599px]:-translate-x-1/2 max-[599px]:rounded-full max-[599px]:bg-line-strong',
  panelHeading: 'flex min-w-0 flex-col gap-0.5',
  panelTitle: 'm-0 text-[1rem] font-bold text-app-ink',
  panelSubtitle: 'm-0 truncate text-[0.8125rem] text-ink-muted',
  panelClose: 'grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-surface-muted hover:text-app-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  panelBody: 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4',
  panelDescription: 'm-0 text-[0.8125rem] leading-[1.6] text-ink-muted',
  panelThread: 'flex flex-col gap-3',
  panelField: 'flex shrink-0 flex-col gap-1.5',
  panelLabel: 'text-[0.8125rem] font-semibold text-app-ink',
  panelFooter: 'flex shrink-0 items-center gap-2 border-t border-line px-5 py-3 max-[599px]:pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
  panelGhostButton: 'inline-flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent px-4 text-[0.9375rem] font-semibold text-ink-muted hover:bg-surface-muted hover:text-app-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary max-[599px]:flex-1',
  panelSubmitButton: classes(
    'inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full border-0 bg-brand-primary px-5 text-[0.9375rem] font-semibold text-white',
    'hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-50 aria-busy:opacity-100 max-[599px]:flex-[2]',
  ),
  panelSpinner: 'size-4 rounded-full border-2 border-white/40 border-t-white motion-safe:animate-spin',
  panelTurn: 'flex flex-col gap-2',
  panelQuestion: 'm-0 self-end max-w-[90%] rounded-[1rem] rounded-br-[0.35rem] bg-brand-soft px-3.5 py-2.5 text-[0.875rem] leading-[1.55] text-app-ink',
  panelSuggestions: 'flex flex-wrap items-center gap-2',
  panelSuggestionsLead: 'text-[0.75rem] font-semibold text-ink-subtle',
  panelSuggestion: 'cursor-pointer rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[0.8125rem] font-medium text-app-ink hover:border-brand-primary hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  panelInput: classes(
    'min-h-[4.5rem] w-full resize-none rounded-[0.85rem] border border-line-strong bg-surface px-3 py-2.5 text-[0.9375rem] leading-[1.55] text-app-ink placeholder:text-ink-subtle outline-0',
    'focus:border-brand-primary focus:shadow-focus disabled:cursor-wait disabled:bg-surface-muted disabled:text-ink-muted max-[599px]:text-base',
  ),
} as const
