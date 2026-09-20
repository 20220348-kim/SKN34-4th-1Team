import { useEffect, useId, useRef } from 'react'

import type { SupportProgram } from '../../../domain/entities/SupportProgram'

type Props = {
  open: boolean
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  programs: SupportProgram[]
  selectedProgramKeys: readonly string[]
  selectionLimit: number
  description: string
  listLabel: string
  isSupported?: (program: SupportProgram) => boolean
  /** 고를 수 없는 공고의 버튼 글자입니다. 이유가 공고마다 다르면 함수로 넘깁니다. */
  unsupportedLabel?: string | ((program: SupportProgram) => string)
  onToggle: (program: SupportProgram) => void
  onRetry: () => void
  onClose: () => void
}

const muted = 'text-sm leading-6 text-slate-600'
const button = 'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-emerald-700'
const primary = 'inline-flex items-center justify-center rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-[#066538] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-brand-primary'
const warning = 'rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950'
const programKey = (program: Pick<SupportProgram, 'sourceCode' | 'id'>) => `${program.sourceCode}:${program.id}`

export function SavedSupportProgramPickerDialog({
  open, phase, programs, selectedProgramKeys, selectionLimit, description, listLabel,
  isSupported = () => true, unsupportedLabel = '선택할 수 없음', onToggle, onRetry, onClose,
}: Props) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) closeRef.current?.focus() }, [open])
  if (!open) return null

  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => { if (event.target === event.currentTarget) onClose() }} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <section className="flex max-h-[min(80vh,44rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
        <div><h3 className="text-lg font-bold" id={titleId}>관심 공고함에서 선택</h3><p className={muted}>{description}</p></div>
        <button ref={closeRef} type="button" className="grid size-10 shrink-0 place-items-center rounded-full text-xl hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-700" aria-label="관심 공고함 닫기" onClick={onClose}>×</button>
      </header>
      <div className="min-h-36 flex-1 overflow-y-auto p-5">
        {(phase === 'idle' || phase === 'loading') && <p role="status">관심 공고를 불러오는 중입니다.</p>}
        {phase === 'failed' && <div className={warning} role="alert"><p>관심 공고를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p><button type="button" className={`${button} mt-3`} onClick={onRetry}>다시 불러오기</button></div>}
        {phase === 'ready' && programs.length === 0 && <p className={muted}>관심 공고함에 담은 공고가 없습니다.</p>}
        {programs.length > 0 && <ul className="space-y-3" aria-label={listLabel}>{programs.map((program) => {
          const key = programKey(program)
          const selected = selectedProgramKeys.includes(key)
          const supported = isSupported(program)
          const action = !supported
            ? (typeof unsupportedLabel === 'function' ? unsupportedLabel(program) : unsupportedLabel)
            : selected ? '선택 해제' : '선택'
          return <li className={`rounded-xl border p-4 transition-colors ${selected ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200' : 'border-slate-200 bg-white'}`} key={key}><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><strong>{program.title}</strong><p className={muted}>{program.organization} · {({ OPEN: '접수 중', CLOSED: '접수 종료', UPCOMING: '접수 예정', UNKNOWN: '접수 상태 미확인' })[program.status]}</p><p className={muted}>{program.applicationPeriod}</p></div><button type="button" className={selected ? primary : button} aria-label={`${program.title} 관심 공고 ${action}`} aria-pressed={selected} disabled={!supported || (!selected && selectedProgramKeys.length >= selectionLimit)} onClick={() => onToggle(program)}>{action}</button></div></li>
        })}</ul>}
      </div>
      <footer className={`flex items-center gap-3 border-t border-slate-200 px-5 py-4 ${selectionLimit === 1 ? 'justify-end' : 'justify-between'}`}>
        {selectionLimit > 1 && <span className="text-sm font-semibold text-emerald-900">{selectedProgramKeys.length}/{selectionLimit} 선택</span>}
        <button type="button" className={primary} onClick={onClose}>선택 완료</button>
      </footer>
    </section>
  </div>
}
