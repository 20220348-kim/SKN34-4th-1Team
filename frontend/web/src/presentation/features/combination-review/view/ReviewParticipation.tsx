import { useId, useState } from 'react'
import type { Participation, ReviewProgram } from '../../../../domain/entities/CombinationReview'
import { SelectField } from '../../../shared/workspace/SelectField'
import { useFloatingPopover } from '../../../shared/workspace/useFloatingPopover'
import { reviewStyles as s } from './CombinationReview.styles'

const fields = [
  ['applicationSubmitted', '신청'], ['selected', '선정'], ['commitmentSubmitted', '확약'],
  ['agreementSigned', '협약'], ['executionStatus', '수행'], ['fundingReceived', '교부'],
] as const
const answerLabels = { UNKNOWN: '모름', YES: '예', NO: '아니오' }
const executionLabels = { UNKNOWN: '모름', NOT_STARTED: '시작 전', IN_PROGRESS: '수행 중', COMPLETED: '완료', STOPPED: '중단' }
const fieldHelp = {
  applicationSubmitted: '해당 사업에 신청서를 제출하여 접수가 이루어졌는지를 선택합니다.',
  selected: '평가·심사 후 지원 대상으로 선정되었다는 통보를 받았는지를 선택합니다.',
  commitmentSubmitted: '선정 이후 사업 참여나 의무 이행을 위한 확약서를 제출했는지를 선택합니다.',
  agreementSigned: '주관기관과 지원 조건 및 사업 수행에 관한 협약을 체결했는지를 선택합니다.',
  executionStatus: '협약 이후 사업이 시작 전·수행 중·완료·중단 중 어느 상태인지 선택합니다.',
  fundingReceived: '지원금·보조금이 실제로 지급(교부)되었는지를 선택합니다.',
} as const

export function ReviewParticipation({ program, index, name, onChange, onRemove }: {
  program: ReviewProgram; index: number; name?: string; onChange?: (value: Participation) => void; onRemove?: () => void
}) {
  const fieldIdPrefix = useId()
  return <fieldset className={s.card}>
    <legend className="px-2 font-semibold">사업 {index + 1} · {name ?? '공고 정보 확인 중'}</legend>
    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {fields.map(([key, label]) => {
        const options = key === 'executionStatus' ? executionLabels : answerLabels
        const fieldId = `${fieldIdPrefix}-${key}`
        const tooltipId = `${fieldId}-help`
        return <div className="text-sm" key={key}>
          <div className="flex items-center justify-between gap-2">
            {onChange ? <label htmlFor={fieldId}>{label}</label> : <span>{label}</span>}
            <ParticipationHelp id={tooltipId} label={label} text={fieldHelp[key]} />
          </div>
          {onChange ? <SelectField id={fieldId} label={`사업 ${index + 1} ${label}`} className={s.input} value={program.participation[key]}
            options={Object.entries(options).map(([value, text]) => ({ value, label: text }))}
            onChange={(value) => onChange({ ...program.participation, [key]: value })} /> : <strong className="mt-1 block">{Object.entries(options).find(([value]) => value === program.participation[key])?.[1]}</strong>}
        </div>
      })}
    </div>
    {onRemove && <button type="button" className={`${s.button} mt-4`} onClick={onRemove}>사업 {index + 1} 선택 해제</button>}
  </fieldset>
}

/** 항목 옆 `?` 도움말입니다. 위쪽에 띄우되 좌우로 화면을 벗어나면 안쪽으로 옮깁니다. */
function ParticipationHelp({ id, label, text }: { id: string; label: string; text: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const { reference, floating, floatingStyles } = useFloatingPopover({ open: isOpen, placement: 'top-end', gap: 8 })
  return <span className="relative inline-flex" onMouseEnter={() => setIsOpen(true)} onMouseLeave={() => setIsOpen(false)}>
    <button ref={reference} type="button" aria-label={`${label} 도움말`} aria-describedby={id}
      onFocus={() => setIsOpen(true)} onBlur={() => setIsOpen(false)}
      className="grid size-5 place-items-center rounded-full bg-emerald-700 text-xs font-bold text-white shadow-sm hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">?</button>
    <span id={id} role="tooltip" ref={floating} style={floatingStyles}
      className={`pointer-events-none z-20 w-64 rounded-lg bg-emerald-950 px-3 py-2 text-xs leading-5 text-white shadow-lg transition-opacity ${isOpen ? 'visible opacity-100' : 'invisible opacity-0'}`}>{text}</span>
  </span>
}
