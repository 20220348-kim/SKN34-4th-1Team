import { useEffect, useRef, useState } from 'react'
import { OpsApiError, saveRagCaseReview, type RagCaseReviewInput, type RagMaterial, type RagReviewState } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

type Decision = RagCaseReviewInput['answer_decision']
const labels: Record<Decision, string> = { SUITABLE: '적합', UNSUITABLE: '부적합', DEFERRED: '판단 보류' }
const dimensions = ['retrieval', 'answer', 'citation'] as const
type Props = {
  disabled?: boolean; runId: string; item: RagMaterial['cases'][number]; state: RagReviewState;
  onExpired: () => void; onSaved: (value: RagReviewState) => void; onLock: (locked: boolean) => void;
}

export function RagCaseReviewForm({ runId, item, state, onExpired, onSaved, onLock, disabled = false }: Props) {
  const measured = { retrieval: item.candidate.retrieved_chunk_ids !== null, answer: item.candidate.answer !== null, citation: item.candidate.answer !== null }
  const defaults = { retrieval: measured.retrieval ? '' : 'DEFERRED', answer: measured.answer ? '' : 'DEFERRED', citation: measured.citation ? '' : 'DEFERRED' } as const
  const [decisions, setDecisions] = useState<Record<typeof dimensions[number], Decision | ''>>(defaults)
  const [comment, setComment] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const history = state.case_reviews.filter((row) => row.case_id === item.case_id)
  const markDirty = () => { setDirty(true); onLock(true) }
  const discard = () => { setDecisions(defaults); setComment(''); setDirty(false); onLock(false) }
  const save = async () => {
    if (disabled || inFlight.current || conflict || !comment.trim() || !decisions.retrieval || !decisions.answer || !decisions.citation) return
    inFlight.current = true; setBusy(true); onLock(true); setError('')
    try {
      const value = await saveRagCaseReview(runId, {
        case_id: item.case_id, retrieval_decision: decisions.retrieval, answer_decision: decisions.answer, citation_decision: decisions.citation,
        comment: comment.trim(), material_sha256: state.material.material_sha256, rubric_version: state.rubric.version, review_version: state.review_version,
      }, state.reviewer_id)
      if (mounted.current) { onLock(false); onSaved(value) }
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof OpsApiError && [401, 403].includes(cause.status)) { onExpired(); return }
      if (cause instanceof OpsApiError && cause.status === 409) setConflict(true)
      setError(cause instanceof Error ? cause.message : '검토를 저장하지 못했습니다.')
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return <section className="space-y-3 rounded-xl border border-line p-4" aria-label="RAG 사례 검토 기록" aria-busy={busy}>
    <h3 className="font-semibold">후보 사례 검토 저장</h3>
    <p className="text-sm">원문·검색 결과·후보 답변을 대조하고 각 항목을 판단하세요. 품질 점검에는 저장된 검토만 반영됩니다. 검토 저장은 합격이나 기준 지정으로 이어지지 않습니다.</p>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
      {dimensions.map((key) => {
        const criterion = state.rubric.criteria.find((value) => value.key === key)
        return <label key={key} className="block text-sm font-semibold">{criterion?.label}
          <p className="font-normal">{criterion?.description}{!measured[key] && ' · 미측정: 판단 보류만 가능'}</p>
          <select aria-label={criterion?.label} className="mt-1 w-full rounded-lg border border-line p-2" value={decisions[key]} disabled={disabled || busy || conflict || !measured[key]} required onChange={(event) => { setDecisions({ ...decisions, [key]: event.target.value as Decision | '' }); markDirty() }}>
            {measured[key] && <option value="">판단 선택</option>}
            {(Object.keys(labels) as Decision[]).filter((value) => measured[key] || value === 'DEFERRED').map((value) => <option key={value} value={value}>{labels[value]}</option>)}
          </select>
        </label>
      })}
      <label className="block text-sm font-semibold">검토 근거
        <textarea className="mt-1 w-full rounded-lg border border-line p-2" value={comment} maxLength={3000} rows={3} required disabled={disabled || busy || conflict} onChange={(event) => { setComment(event.target.value); markDirty() }} placeholder="대조한 원문·청크와 판단 이유를 기록하세요." />
      </label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {conflict && <p className="text-sm">입력 내용을 확인한 뒤 ‘입력 취소’를 누르고 검토 자료를 새로고침하세요. 기존 판단은 새 자료에 자동으로 적용되지 않습니다.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={styles.secondaryButton} disabled={disabled || busy || conflict || !comment.trim() || dimensions.some((key) => !decisions[key])}>{busy ? '저장 중…' : '사례 검토 저장'}</button>
        <button type="button" className={styles.secondaryButton} disabled={disabled || busy || !dirty} onClick={discard}>입력 취소</button>
      </div>
      {dirty && <p className="text-xs">입력을 저장하거나 취소한 뒤 다른 사례를 선택하거나 자료를 새로고침할 수 있습니다.</p>}
    </form>
    <h4 className="font-semibold">이 사례의 검토 이력 · {history.length}건</h4>
    {history.length === 0 && <p className="text-sm">저장된 사람 검토가 없습니다.</p>}
    {history.map((row) => <article key={row.id} className="rounded-lg bg-surface-muted p-3 text-sm" aria-label={`검토 이력 ${row.version}`}>
      <p>#{row.version} · {row.is_current ? '현재 자료의 최신 검토' : '이전 검토'} · {row.reviewed_by} · {new Date(row.created_at).toLocaleString('ko-KR')}</p>
      <p>검색: {labels[row.retrieval_decision]} · 답변: {labels[row.answer_decision]} · 인용: {labels[row.citation_decision]}</p>
      <p className="whitespace-pre-wrap break-words">{row.comment}</p>
      <details className="break-all text-xs"><summary>검토 당시 자료 정보</summary>
        <p>기준: {row.rubric_version} · 자료: {row.material_sha256}</p><p>평가 자료: {row.fixture_sha256}</p>
        <p>후보 캡처: {row.candidate_capture_sha256}</p><p>비교 캡처: {row.reference_capture_sha256}</p><p>실행 명세: {row.execution_spec_sha256}</p>
      </details>
    </article>)}
  </section>
}
