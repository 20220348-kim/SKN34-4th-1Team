import { useEffect, useRef, useState } from 'react'
import { assessEvaluationQuality, OpsApiError, saveFixtureReview } from '../../../data/ops/opsApi'
import type { EvaluationReview } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles, workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'

const labels = { NOT_EVALUATED: '미판정', NEEDS_REVIEW: '검토 필요', FAIL: '불합격', PASS: '합격' }
const fixtureLabels = { APPROVED: '기준 자료 검토 승인', CHANGES_REQUESTED: '기준 자료 수정 필요', DEFERRED: '기준 자료 판단 보류' }

export function QualityReviewPanel({ runId, data, busy, onBusy, onDirty, onConflict, onSaved, onExpired }: {
  runId: string; data: EvaluationReview; busy: boolean; onBusy: (value: boolean) => void;
  onDirty: (value: boolean) => void; onConflict: () => void;
  onSaved: (value: EvaluationReview) => void; onExpired: () => void;
}) {
  const [decision, setDecision] = useState<'APPROVED' | 'CHANGES_REQUESTED' | 'DEFERRED' | ''>('')
  const [comment, setComment] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const active = useRef(false)
  const quality = data.quality
  const cases = data.material?.cases.map((item) => item.case_id).join(', ')
  const dirty = decision !== '' || comment !== '' || confirmed
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => { setConfirmed(false) }, [runId, data.material?.fixture_sha256, quality?.fixture_version, cases])
  if (!quality) return <p className="text-sm text-ink-muted">품질 판정 정보를 확인할 수 없습니다.</p>
  const current = quality.history.find((item) => item.id === quality.current_id)
  const save = async (fixture: boolean) => {
    if (active.current || busy || !data.material || !quality.input_sha256) return
    if (fixture && (!decision || !comment.trim() || !confirmed)) return
    if (!fixture && dirty) return
    active.current = true; onBusy(true); setError(''); setNotice('')
    try {
      const value = fixture && decision ? await saveFixtureReview(runId, {
        decision, comment: comment.trim(), fixture_sha256: data.material.fixture_sha256,
        case_ids: data.material.cases.map((item) => item.case_id), rubric_version: quality.fixture_rubric_version,
        fixture_version: quality.fixture_version,
      }) : await assessEvaluationQuality(runId, quality.input_sha256)
      onSaved(value)
      setNotice(fixture ? '기준 자료 검토를 저장했습니다. 이제 사례별 후보 답변을 검토하세요.' : `품질 판정을 저장했습니다: ${labels[value.quality?.status ?? 'NOT_EVALUATED']}. 아래 판정 사유와 다음 단계를 확인하세요.`)
      if (fixture) { setDecision(''); setComment(''); setConfirmed(false) }
    } catch (reason) {
      if (reason instanceof OpsApiError && reason.status === 409) onConflict()
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) onExpired()
      else setError(reason instanceof Error ? reason.message : '품질 판정을 저장하지 못했습니다.')
    } finally { active.current = false; onBusy(false) }
  }
  return <section id="quality-review" tabIndex={-1} aria-label="품질 판정" style={{ scrollMarginTop: 'calc(var(--workspace-header-h, 0px) + 1rem)' }} className="grid gap-4 rounded-xl border border-line p-4">
    <h3 className="font-bold">품질 판정 · <span className={workspaceTagClassName(quality.status === 'PASS' ? 'ok' : quality.status === 'FAIL' ? 'danger' : 'info')}>{labels[quality.status]}</span></h3>
    <p className="text-sm leading-6">실행 완료와 품질 판정은 별개입니다. 합격은 표시된 사례와 정책의 범위에만 적용되며, 전체 모델의 정확도를 보장하지 않습니다.</p>
    <p className="text-xs text-ink-muted">정책: {quality.policy?.definition.version ?? '확인 불가'} · 자동 의미 충실도: 미측정 · 의미 판단: 사례별 사람 검토</p>
    {!quality.is_current && quality.history.length > 0 && <p className="text-sm text-amber-800">자료·정책·검토가 변경됐습니다. 이전 판정은 이력으로 보존되며 다시 판정해야 합니다.</p>}
    {current && <ul className="list-disc pl-5 text-sm">{current.reasons.map((reason, index) => <li key={`${reason.code}-${reason.case_id}-${index}`}>{reason.case_id ? `${reason.case_id}: ` : ''}{reason.message}</li>)}</ul>}
    {quality.blocked_reason && <p role="alert" className="text-sm text-amber-800">{quality.blocked_reason}</p>}
    {notice && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-brand-primary">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button className={`${styles.secondaryButton} justify-self-start`} disabled={busy || dirty || !data.material || !quality.input_sha256} onClick={() => void save(false)}>현재 근거로 품질 판정 저장</button>
    {dirty && <p className="text-sm text-amber-800">저장하지 않은 기준 자료 검토가 있습니다. 먼저 자료 검토를 저장하거나 입력을 비운 뒤 다른 검토·품질 판정·기준 지정을 진행하세요.</p>}
    <details id="fixture-review" tabIndex={-1} style={{ scrollMarginTop: 'calc(var(--workspace-header-h, 0px) + 1rem)' }} className="grid gap-3"><summary className="cursor-pointer text-sm font-semibold">평가 기준 자료 검토 · {quality.fixture_reviews[0] ? fixtureLabels[quality.fixture_reviews[0].decision] : '미검토'}</summary>
      <div className="mt-3 grid gap-3 text-sm">
        <p>사례 선택에서 각 사례의 AI 작성 참조 조건을 원문 근거와 대조합니다. 기대 상태·기대 인용·포함할 사실·금지 주장을 모두 확인하세요. 이 기록은 후보 답변 검토와 별개이며 AI 작성 출처는 유지됩니다.</p>
        <p>대상 사례: {data.material?.cases.map((item) => item.case_id).join(', ') ?? '자료 확인 불가'}</p>
        <label className="grid gap-2">평가 기준 자료 판단<select className="rounded-xl border border-line p-3" value={decision} disabled={busy} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="">판단 선택</option><option value="APPROVED">검토 승인</option><option value="CHANGES_REQUESTED">수정 필요</option><option value="DEFERRED">판단 보류</option></select></label>
        <label className="grid gap-2">평가 기준 자료 검토 사유<textarea className="rounded-xl border border-line p-3" rows={2} value={comment} maxLength={3000} disabled={busy} onChange={(event) => setComment(event.target.value)} /></label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />모든 대상 사례의 평가 기준 자료를 확인하고 위 판단을 기록합니다.</label>
        <button className={`${styles.secondaryButton} justify-self-start`} disabled={busy || !data.material || !quality.input_sha256 || !confirmed || !decision || !comment.trim()} onClick={() => void save(true)}>평가 기준 자료 검토 저장</button>
        <p className="text-xs text-ink-muted">기준 자료 검토를 변경하면 해당 데이터셋의 활성 비교 기준이 해제되고 품질 재판정이 필요합니다.</p>
        {quality.fixture_reviews.map((item) => <div key={item.id} className="rounded-xl bg-slate-50 p-3"><p>{fixtureLabels[item.decision]} · {item.reviewed_by} · {new Date(item.created_at).toLocaleString('ko-KR')}</p><p className="whitespace-pre-wrap">{item.comment}</p></div>)}
      </div>
    </details>
    {quality.history.length > 0 && <details><summary className="cursor-pointer text-sm font-semibold">품질 판정 이력 · {quality.history.length}건</summary><ol className="mt-3 grid gap-3">{quality.history.map((item) => <li key={item.id} className="rounded-xl bg-slate-50 p-3 text-sm"><p>{labels[item.status]} · {item.policy.definition.version} · {item.assessed_by} · {new Date(item.created_at).toLocaleString('ko-KR')}</p><p className="break-all text-xs">판정 근거 ID: {item.input_sha256}</p><ul>{item.reasons.map((reason, index) => <li key={index}>{reason.case_id ? `${reason.case_id}: ` : ''}{reason.message}</li>)}</ul></li>)}</ol></details>}
  </section>
}
