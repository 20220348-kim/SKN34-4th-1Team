import type { EvaluationReview } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

// Navigation only. The existing API remains responsible for approval and promotion.
export function EvaluationReviewProgress({ data, hasDrafts, disabled, onNavigate }: {
  data: EvaluationReview; hasDrafts: boolean; disabled: boolean; onNavigate: (target: string) => void
}) {
  const material = data.material
  const quality = data.quality
  if (!material?.cases.length || !quality || !quality.input_sha256 || disabled) return <section aria-label="검토 진행 안내" className="rounded-xl bg-slate-50 p-4 text-sm">
    <h3 className="font-semibold">검토 진행 안내</h3>
    <p>현재 검토 자료와 판정 정보를 확인한 뒤 진행 상태를 안내합니다.</p>
  </section>
  const fixture = quality.fixture_reviews[0]
  const fixtureCurrent = !!fixture && fixture.fixture_sha256 === material.fixture_sha256
    && fixture.rubric_version === quality.fixture_rubric_version
    && fixture.case_ids.length === material.cases.length
    && fixture.case_ids.every((id, index) => id === material.cases[index].case_id)
  const fixtureApproved = fixtureCurrent && fixture.decision === 'APPROVED'
  const cases = material.cases.map((item) => {
    const review = data.case_reviews.find((row) => row.case_id === item.case_id)
    const current = review?.capture_sha256 === material.capture_sha256
      && review?.fixture_sha256 === material.fixture_sha256 && review?.rubric_version === data.rubric.version
    return { id: item.case_id, suitable: current && review.decision === 'SUITABLE',
      state: current ? { SUITABLE: '적합', UNSUITABLE: '부적합', DEFERRED: '판단 보류' }[review.decision] : review ? '재검토 필요' : '미검토' }
  })
  const remaining = cases.filter((item) => !item.suitable)
  const qualityPassed = quality.is_current && quality.status === 'PASS'
  const baselineCurrent = data.is_baseline && !data.baseline_requires_review && data.can_promote
    && fixtureApproved && remaining.length === 0 && data.approval_current && qualityPassed
  const steps = [
    { label: '기준 자료 검토', done: fixtureApproved, hint: '평가 조건이 원문과 맞는지 확인', value: fixtureApproved ? '승인 완료' : fixtureCurrent ? fixture.decision === 'DEFERRED' ? '판단 보류' : '수정 필요' : fixture ? '재검토 필요' : '미검토' },
    { label: '사례별 답변 검토', done: remaining.length === 0, hint: '각 답변의 판단과 사유 저장', value: `적합 ${cases.length - remaining.length} / ${cases.length}건` },
    { label: '전체 응답 승인', done: data.approval_current, hint: '모든 사례의 검토 결과 승인', value: data.approval_current ? '승인 완료' : '승인 필요' },
    { label: '품질 판정', done: qualityPassed, hint: '저장된 검토로 품질 판정', value: qualityPassed ? '현재 근거로 합격' : quality.is_current ? quality.status === 'FAIL' ? '불합격 · 근거 확인 필요' : '검토 필요' : quality.history.length ? '재판정 필요' : '미판정' },
    { label: '비교 기준 지정', done: baselineCurrent, hint: '다음 평가에 쓸 비교 기준 선택', value: baselineCurrent ? '지정 완료' : data.is_baseline ? '기존 기준 재검토 필요' : data.can_promote ? '지정 가능' : '조건 미충족' },
  ]
  const next = !fixtureApproved ? { target: 'fixture-review', label: '기준 자료 검토로 이동' }
    : remaining.length ? { target: `case-review-${remaining[0].id}`, label: `${remaining[0].id} 사례 검토로 이동` }
    : !data.approval_current ? { target: 'overall-review', label: '전체 응답 승인으로 이동' }
    : !qualityPassed ? { target: 'quality-review', label: '품질 판정과 사유로 이동' }
    : !baselineCurrent ? { target: 'overall-review', label: '비교 기준 지정으로 이동' } : null
  const completed = steps.filter((step) => step.done).length
  return <section aria-label="검토 진행 안내" className="grid gap-4 rounded-xl border border-brand-primary/20 bg-[#f3f7f5] p-5 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">검토 진행 안내</h3><span className="font-semibold tabular-nums">{completed} / {steps.length}단계 완료</span></div>
    <progress className="h-2 w-full accent-brand-primary" aria-label="검토 단계 진행률" value={completed} max={steps.length} />
    <p>대상 사례: {cases.map((item) => item.id).join(', ')} · 현재 저장된 자료와 검토 기록 기준입니다.</p>
    <ol className="grid grid-cols-2 gap-3 lg:grid-cols-5">{steps.map((step, index) => <li key={step.label} className={`min-w-0 border-t-2 pt-3 ${step.done ? 'border-brand-primary' : 'border-line'}`}><strong>{index + 1}. {step.label}</strong><p className="mt-1 font-medium">{step.value}</p><p className="mt-1 text-xs leading-5 text-ink-muted">{step.hint}</p></li>)}</ol>
    {remaining.length > 0 && <p>확인할 사례: {remaining.map((item) => `${item.id} (${item.state})`).join(', ')}</p>}
    {hasDrafts ? <p>저장하지 않은 사례 판단이 있습니다. 사례 검토를 저장한 뒤 다음 단계를 확인하세요.</p>
      : next ? <button type="button" className={`${styles.primaryButton} justify-self-start`} onClick={() => onNavigate(next.target)}>{next.label}</button>
      : <p>이 실행이 현재 자료의 비교 기준입니다. 다른 자료나 전체 모델의 품질 승인을 뜻하지 않습니다.</p>}
    <p className="text-xs text-ink-muted">이동 버튼은 검토·판정·기준을 저장하지 않습니다. 각 위치에서 내용을 확인하고 별도로 저장하세요.</p>
  </section>
}
