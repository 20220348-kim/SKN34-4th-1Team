import { useEffect, useRef, useState } from 'react'
import { assessRagQuality, OpsApiError, type RagReviewState } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const labels = { NOT_EVALUATED: '미판정', NEEDS_REVIEW: '검토 필요', FAIL: '부적합' }
const dimensions = { retrieval: '검색', answer: '답변', citation: '인용' }
type Props = {
  runId: string; state: RagReviewState; disabled: boolean; onBusy: (value: boolean) => void;
  onSaved: (value: RagReviewState) => void; onExpired: () => void;
}

export function RagQualityPanel({ runId, state, disabled, onBusy, onSaved, onExpired }: Props) {
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const quality = state.quality
  const current = quality.history.find((record) => record.id === quality.current_id)
  const save = async () => {
    if (active.current || disabled || conflict) return
    active.current = true; setBusy(true); onBusy(true); setError('')
    try {
      const value = await assessRagQuality(runId, quality.input_sha256, state.reviewer_id)
      if (mounted.current) onSaved(value)
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof OpsApiError && [401, 403].includes(cause.status)) { onExpired(); return }
      if (cause instanceof OpsApiError && cause.status === 409) setConflict(true)
      setError(cause instanceof Error ? cause.message : '품질 점검을 저장하지 못했습니다.')
    } finally {
      active.current = false
      if (mounted.current) { setBusy(false); onBusy(false) }
    }
  }
  const reasons = (record: NonNullable<typeof current>) => <ul className="list-disc space-y-1 pl-5">
    {record.reasons.map((reason, index) => <li key={index}>{reason.case_id && `${reason.case_id} · `}{reason.dimension && `${dimensions[reason.dimension]}: `}{reason.message}</li>)}
  </ul>
  return <section className="space-y-3 rounded-xl border border-sample-border p-4" aria-label="RAG 품질 점검" aria-busy={busy}>
    <h3 className="font-semibold">RAG 품질 점검 · {labels[quality.status]}</h3>
    <p className="text-sm">현재 저장된 검토로 검색·답변·인용의 부적합과 검토 필요 사유를 기록합니다. 원본 실행 실패와 미측정은 별도로 표시합니다.</p>
    <p className="text-sm">원문·AI 참조 조건의 승인 절차가 없어 현재 정책은 합격을 부여하지 않습니다. 합성·무료 대역 기록은 현재 모델의 품질이나 비교 기준을 증명하지 않습니다.</p>
    <p className="text-xs">정책: {quality.policy.definition.version} · 모델 호출 없음</p>
    {!quality.is_current && quality.history.length > 0 && <p className="text-sm text-amber-800">자료·정책·검토가 변경되어 다시 점검해야 합니다. 이전 판정은 이력으로 보존됩니다.</p>}
    {current && <div role="status" className="space-y-2 text-sm"><p>현재 판정: {labels[current.status]} · {current.assessed_by}</p>{reasons(current)}</div>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {conflict && <p className="text-sm">검토 자료를 새로고침한 뒤 현재 근거로 다시 점검하세요.</p>}
    <button type="button" className={styles.secondaryButton} disabled={disabled || busy || conflict} onClick={() => void save()}>{busy ? '품질 점검 저장 중…' : '현재 검토로 품질 점검 저장'}</button>
    {quality.history.length > 0 && <details><summary className="cursor-pointer font-semibold">RAG 품질 점검 이력 · {quality.history.length}건</summary>
      <ol className="space-y-3 py-3">{quality.history.map((record) => <li key={record.id} className="rounded-lg bg-slate-50 p-3 text-sm">
        <p>#{record.id} · {labels[record.status]} · {record.assessed_by} · {new Date(record.created_at).toLocaleString('ko-KR')}</p>
        <p className="break-all text-xs">정책: {record.policy.definition.version} · 판정 근거: {record.input_sha256}</p>
        {reasons(record)}
      </li>)}</ol>
    </details>}
  </section>
}
