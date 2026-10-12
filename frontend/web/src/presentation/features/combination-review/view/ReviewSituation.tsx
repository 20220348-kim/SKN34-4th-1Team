import { useId } from 'react'
import { Link } from 'react-router'
import { reviewProgramKey, type ReviewProgram, type ReviewRelation } from '../../../../domain/entities/CombinationReview'
import { SelectField } from '../../../shared/workspace/SelectField'
import { reviewStyles as s } from './CombinationReview.styles'
import {
  participationToReviewStatus, reviewProgramStatusLabels, reviewRelationAnswerLabels, reviewRelationLabels, reviewStatusToParticipation, type ReviewProgramStatus,
} from './currentStatus'

export type ReviewSituation = { programs: ReviewProgram[]; relation: ReviewRelation }

const statusOptions = Object.entries(reviewProgramStatusLabels).map(([value, label]) => ({ value, label }))
const relationFields = ['sameProject', 'sameCost'] as const
const relationAnswers = ['YES', 'NO', 'UNKNOWN'] as const

/**
 * 내 상황(선택) 입력 칸입니다. 사업마다 지금 상태 하나(모름 · 신청 전 · 신청함 · 선정·협약·수행 중 · 받음·종료)와
 * 두 사업의 관계 두 칸(같은 과제·제품 · 같은 비용 항목, 예 · 아니오 · 모름)을 고릅니다. 상태는 기존 사실 6개로 저장합니다.
 */
export function ReviewSituationFields({ value, names, onChange }: { value: ReviewSituation; names: Record<string, string>; onChange: (next: ReviewSituation) => void }) {
  const prefix = useId()
  return <div className="space-y-4">
    <div className="grid gap-3 @min-[40rem]/workspace:grid-cols-2">
      {value.programs.map((program, index) => <div key={reviewProgramKey(program)} className="min-w-0">
        <label htmlFor={`${prefix}-status-${index}`} className="block text-sm font-semibold [overflow-wrap:anywhere]">사업 {index + 1} · {names[reviewProgramKey(program)] ?? '공고 정보 확인 중'}</label>
        <SelectField id={`${prefix}-status-${index}`} label={`사업 ${index + 1} 지금 상태`} className={s.input} value={participationToReviewStatus(program.participation)} options={statusOptions}
          onChange={(status) => onChange({ ...value, programs: value.programs.map((item, itemIndex) => itemIndex === index
            ? { ...item, participation: reviewStatusToParticipation(status as ReviewProgramStatus, item.participation) } : item) })} />
      </div>)}
    </div>
    {relationFields.map((field) => <fieldset key={field} className="min-w-0">
      <legend className="text-sm font-semibold">{reviewRelationLabels[field]}</legend>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {relationAnswers.map((answer) => <label key={answer} className={s.choice}>
          <input type="radio" className="sr-only" name={`${prefix}-${field}`} value={answer} checked={value.relation[field] === answer}
            onChange={() => onChange({ ...value, relation: { ...value.relation, [field]: answer } })} />
          {reviewRelationAnswerLabels[answer]}
        </label>)}
      </div>
    </fieldset>)}
  </div>
}

/**
 * 세 질문 결과 아래의 "내 상황으로 좁히기"입니다. 고른 상황을 검토 입력으로 저장(입력 버전 확인)한 뒤 새 분석을 한 번 접수합니다.
 * 바꾼 것이 없거나 지금 새 분석을 보낼 수 없으면 그 이유를 버튼 앞에 적습니다.
 */
export function ReviewNarrowingPanel({ value, names, dirty, busy, blocked, pendingPath, onChange, onSubmit }: {
  value: ReviewSituation; names: Record<string, string>; dirty: boolean; busy: boolean; blocked: string | null
  /** 응답을 확인하지 못한 분석 요청이 있으면 그 요청을 확인할 공고 분석 단계 주소입니다. */
  pendingPath: string | null
  onChange: (next: ReviewSituation) => void; onSubmit: () => void
}) {
  const reasonId = useId()
  const reason = pendingPath ? '응답을 확인하지 못한 분석 요청이 있어요. 공고 분석 단계에서 먼저 확인해 주세요.'
    : blocked ?? (dirty ? null : '상황을 바꾸면 다시 분석할 수 있어요')
  return <section className={`${s.card} space-y-4`} aria-label="내 상황으로 좁히기">
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2"><h2 className="font-bold">내 상황으로 좁히기</h2><span className={`${s.badge} ${s.badgeNeutral}`}>선택</span></div>
      <p className={s.muted}>사업별 지금 상태와 두 사업이 같은 과제·비용인지 고르면 조건부 답을 좁혀 다시 분석해요. 저장한 입력으로 유료 분석을 한 번 실행해요.</p>
    </div>
    <fieldset disabled={busy} className="min-w-0">
      <legend className="sr-only">내 상황</legend>
      <ReviewSituationFields value={value} names={names} onChange={onChange} />
    </fieldset>
    <div className="flex flex-wrap items-center justify-end gap-2">
      {reason && <p className={`${s.stepBarReason} m-0`} id={reasonId}>{reason}</p>}
      {pendingPath && <Link className={s.secondarySm} to={pendingPath}>공고 분석 단계로</Link>}
      <button type="button" className={s.primaryPill} disabled={busy || !!reason} aria-busy={busy} aria-describedby={reason ? reasonId : undefined} onClick={onSubmit}>
        {busy ? <><span className={s.buttonSpinner} aria-hidden="true" />저장 · 접수 중…</> : '저장하고 다시 분석'}
      </button>
    </div>
  </section>
}
