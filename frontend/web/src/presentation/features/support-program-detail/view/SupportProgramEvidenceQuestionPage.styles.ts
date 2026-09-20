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
} as const
