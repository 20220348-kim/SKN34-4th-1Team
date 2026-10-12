/** 지금 단계의 모양입니다. 진행 중 · 돌아가는 중 · 확인 필요 · 모두 완료입니다. */
export type WorkStepState = 'current' | 'running' | 'warn' | 'done'

const stepTone = {
  done: 'border-brand-line text-brand-hover',
  current: 'border-brand-primary bg-brand-soft font-bold text-brand-hover',
  running: 'border-brand-primary bg-brand-soft font-bold text-brand-hover',
  warn: 'border-warning-line bg-warning-soft font-bold text-warning',
  todo: 'border-line text-ink-muted',
} as const

const stepStatus = { done: '완료', current: '지금 단계', running: '진행 중', warn: '확인 필요', todo: '아직' } as const

/**
 * 작업의 단계 띠입니다. 대화의 작업 카드와 작업 화면 맨 위가 같은 모양으로 지금 어느 단계인지 보여 줍니다(화면에서는 [size]를 `page`로 조금 크게). [current] 앞 단계는 완료, 뒤 단계는 아직이고,
 * [state]가 지금 단계의 모양을 정합니다(`done`이면 모든 단계가 완료). 좁은 화면에서는 단계 이름이 말줄임으로 줄어듭니다.
 */
export function WorkSteps({ label, steps, current, state = 'current', size = 'card' }: {
  label: string; steps: readonly string[]; current: number; state?: WorkStepState; size?: 'card' | 'page'
}) {
  return <ol className={`m-0 flex min-w-0 list-none p-0 ${size === 'page' ? 'gap-2' : 'gap-1'}`} aria-label={label}>
    {steps.map((step, index) => {
      const kind = index < current || (index === current && state === 'done') ? 'done' : index === current ? state : 'todo'
      return <li key={step} aria-current={index === current && state !== 'done' ? 'step' : undefined}
        className={`flex min-w-0 flex-1 items-center rounded-md border ${size === 'page' ? 'gap-1.5 px-3 py-2 text-[0.8rem]' : 'gap-1 px-2 py-1 text-[0.72rem]'} ${stepTone[kind]}`}>
        {kind === 'done' ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          : kind === 'running' ? <span className="size-2.5 shrink-0 rounded-full border-2 border-brand-line border-t-brand-primary motion-safe:animate-spin" aria-hidden="true" />
            : <span className="shrink-0 tabular-nums" aria-hidden="true">{index + 1}</span>}
        <span className="min-w-0 truncate">{step}</span>
        <span className="sr-only"> · {stepStatus[kind]}</span>
      </li>
    })}
  </ol>
}
