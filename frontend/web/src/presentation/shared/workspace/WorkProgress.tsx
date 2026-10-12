import type { ReactNode } from 'react'

import { elapsedLabel } from './elapsed'

/**
 * 돌아가는 작업의 진행 카드입니다. 신청 문서의 입력칸 분석 · 초안 생성과 중복 검토 분석이 같은 모양으로 무엇을 하는지와
 * 지난 시간을 보여 주고, 나가도 계속된다는 안내를 맨 아래에 둡니다. 시간에 맞춘 가짜 진행 막대는 두지 않습니다.
 */
export function WorkProgress({ label, title, elapsedSeconds, note, live = true, children }: {
  label: string; title: string; elapsedSeconds: number | null; note: string; live?: boolean; children?: ReactNode
}) {
  // 상태 바뀜을 따로 알리는 화면(중복 검토 입력)은 [live]를 꺼서 지난 시간이 바뀔 때마다 읽지 않게 합니다.
  return <section {...(live ? { role: 'status', 'aria-live': 'polite' as const } : {})} aria-label={label}
    className="flex flex-col gap-3 rounded-2xl border border-brand-line bg-white p-5 shadow-[0_8px_24px_rgb(32_33_36_/_6%)] max-[599px]:p-4">
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 size-[18px] shrink-0 rounded-full border-2 border-brand-line border-t-brand-primary motion-safe:animate-spin" aria-hidden="true" />
      <strong className="min-w-0 flex-1 text-[0.95rem] leading-[1.4] font-bold text-ink">{title}</strong>
      {elapsedSeconds !== null ? <span className="text-[0.78rem] whitespace-nowrap text-ink-muted tabular-nums">{elapsedLabel(elapsedSeconds)}</span> : null}
    </div>
    {children}
    <p className="m-0 border-t border-line pt-2.5 text-[0.78rem] text-ink-muted">{note}</p>
  </section>
}
