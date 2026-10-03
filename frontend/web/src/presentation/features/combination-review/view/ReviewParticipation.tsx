import { useId, useState } from 'react'
import type { Participation, ReviewProgram } from '../../../../domain/entities/CombinationReview'
import { SelectField } from '../../../shared/workspace/SelectField'
import { reviewStyles as s } from './CombinationReview.styles'
import { currentStatusLabels, currentStatusToParticipation, participationToCurrentStatus, showFundingQuestion, type CurrentStatus } from './currentStatus'

export function ReviewParticipation({ program, index, name, onChange, onRemove }: {
  program: ReviewProgram; index: number; name?: string; onChange?: (value: Participation) => void; onRemove?: () => void
}) {
  const prefix = useId()
  const [chosenStatus, setChosenStatus] = useState<CurrentStatus | null>(null)
  const status = chosenStatus ?? participationToCurrentStatus(program.participation)
  return <fieldset className={s.card}>
    <legend className="px-2 font-semibold">사업 {index + 1} · {name ?? '공고 정보 확인 중'}</legend>
    <div className="mt-4 space-y-4">
      <div>
        <label htmlFor={`${prefix}-status`} className="block text-sm font-semibold">지금 어디까지 진행했나요?</label>
        <SelectField id={`${prefix}-status`} label={`사업 ${index + 1} 현재 진행 상태`} className={s.input} value={status}
          options={Object.entries(currentStatusLabels).map(([value, label]) => ({ value, label }))}
          onChange={(value) => { const next = value as CurrentStatus; setChosenStatus(next); onChange?.(currentStatusToParticipation(next, program.participation)) }} />
        {status === 'UNKNOWN' && <p className={s.muted}>저장된 개별 사실이 하나의 진행 상태로 표현되지 않을 수 있습니다. 직접 상태를 바꾸기 전에는 저장된 사실을 유지합니다.</p>}
      </div>
      {showFundingQuestion(status, program.participation) && <div>
        <label htmlFor={`${prefix}-funding`} className="block text-sm font-semibold">지원금을 실제로 받았나요?</label>
        {onChange ? <SelectField id={`${prefix}-funding`} label={`사업 ${index + 1} 지원금 교부 여부`} className={s.input} value={program.participation.fundingReceived}
          options={[{ value: 'UNKNOWN', label: '잘 모르겠음' }, { value: 'YES', label: '예' }, { value: 'NO', label: '아니오' }]}
          onChange={(value) => onChange({ ...program.participation, fundingReceived: value as Participation['fundingReceived'] })} />
          : <strong className="mt-1 block">{{ UNKNOWN: '잘 모르겠음', YES: '예', NO: '아니오' }[program.participation.fundingReceived]}</strong>}
      </div>}
    </div>
    {onRemove && <button type="button" className={`${s.button} mt-4`} onClick={onRemove}>사업 {index + 1} 선택 해제</button>}
  </fieldset>
}
