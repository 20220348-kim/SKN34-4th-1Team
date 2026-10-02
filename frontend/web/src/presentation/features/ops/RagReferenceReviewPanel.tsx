import { useEffect, useRef, useState } from 'react'
import { OpsApiError, saveRagReferenceReview, type RagReferenceReviewInput, type RagReviewState } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

type Decision = RagReferenceReviewInput['decision']
const labels: Record<Decision, string> = { APPROVED: '참조 자료 승인', CHANGES_REQUESTED: '수정 필요', DEFERRED: '판단 보류', REVOKED: '승인 철회' }
type Props = {
  runId: string; state: RagReviewState; disabled: boolean; onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void; onSaved: (value: RagReviewState) => void; onExpired: () => void;
}

export function RagReferenceReviewPanel({ runId, state, disabled, onDirty, onBusy, onSaved, onExpired }: Props) {
  const [decision, setDecision] = useState<Decision | ''>('')
  const [comment, setComment] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const reference = state.reference_review
  const current = reference.history.find((row) => row.id === reference.current_id)
  const markDirty = () => { setDirty(true); onDirty(true) }
  const discard = () => { setDecision(''); setComment(''); setConfirmed(false); setDirty(false); onDirty(false); setError('') }
  const save = async () => {
    if (disabled || inFlight.current || conflict || !decision || !comment.trim() || !confirmed) return
    inFlight.current = true; setBusy(true); onBusy(true); setError('')
    try {
      const value = await saveRagReferenceReview(runId, {
        decision, comment: comment.trim(), confirmed_all_cases: confirmed,
        fixture_sha256: reference.fixture_sha256, case_ids: reference.case_ids,
        rubric_version: reference.rubric.version, review_version: state.review_version,
      }, state.reviewer_id)
      if (mounted.current) { onDirty(false); onSaved(value) }
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof OpsApiError && [401, 403].includes(cause.status)) { onExpired(); return }
      if (cause instanceof OpsApiError && cause.status === 409) setConflict(true)
      setError(cause instanceof Error ? cause.message : '참조 검토를 저장하지 못했습니다.')
    } finally {
      inFlight.current = false
      if (mounted.current) { setBusy(false); onBusy(false) }
    }
  }
  return <section className="space-y-3 rounded-xl border border-sample-border p-4" aria-label="RAG 참조 자료 검토" aria-busy={busy}>
    <h3 className="font-semibold">원문·참조 자료 검토 · {current ? labels[current.decision] : '현재 승인 없음'}</h3>
    <p className="text-sm">{reference.rubric.description} 아래 사례 선택으로 전체 자료를 확인하세요. 승인은 이 실행의 전체 대상에만 적용되며 다른 실행에 자동 적용되지 않습니다.</p>
    <p className="text-sm">AI 작성 출처는 유지합니다. 참조 자료 승인은 후보 답변의 품질 합격이나 비교 기준 지정과 별개입니다.</p>
    <p className="text-sm break-words">검토 대상 {reference.case_ids.length}건: {reference.case_ids.join(', ')}</p>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label className="block text-sm font-semibold">참조 자료 판단
        <select className="mt-1 w-full rounded-lg border border-sample-border p-2" value={decision} required disabled={disabled || busy || conflict} onChange={(event) => { setDecision(event.target.value as Decision | ''); markDirty() }}>
          <option value="">판단 선택</option>
          {(Object.keys(labels) as Decision[]).filter((value) => value !== 'REVOKED' || reference.can_revoke).map((value) => <option key={value} value={value}>{labels[value]}</option>)}
        </select>
      </label>
      <label className="block text-sm font-semibold">참조 검토 근거
        <textarea className="mt-1 w-full rounded-lg border border-sample-border p-2" value={comment} maxLength={3000} rows={3} required disabled={disabled || busy || conflict} onChange={(event) => { setComment(event.target.value); markDirty() }} placeholder="전체 대상의 검토 결과와 승인·수정·보류·철회 이유를 기록하세요." />
      </label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={disabled || busy || conflict} onChange={(event) => { setConfirmed(event.target.checked); markDirty() }} />전체 대상의 원문·청크·질문·기대 상태·기대 인용을 확인했습니다.</label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {conflict && <p className="text-sm">다른 검토나 자료 변경이 있습니다. ‘참조 입력 취소’ 후 검토 자료를 새로고침하고 다시 판단하세요.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={styles.secondaryButton} disabled={disabled || busy || conflict || !decision || !comment.trim() || !confirmed}>{busy ? '참조 검토 저장 중…' : '참조 검토 저장'}</button>
        <button type="button" className={styles.secondaryButton} disabled={disabled || busy || !dirty} onClick={discard}>참조 입력 취소</button>
      </div>
      {dirty && <p className="text-xs">사례를 바꾸어 전체 자료를 확인할 수 있습니다. 참조 입력을 저장하거나 취소한 뒤 후보 검토·품질 점검·새로고침을 진행하세요.</p>}
    </form>
    <details><summary className="cursor-pointer font-semibold">참조 검토 이력 · {reference.history.length}건</summary>
      {reference.history.map((row) => <article key={row.id} className="my-2 rounded-lg bg-sample-bg p-3 text-sm" aria-label={`참조 검토 이력 ${row.version}`}>
        <p>#{row.version} · {labels[row.decision]} · {row.is_current ? '현재 자료의 최신 검토' : '이전 검토'}</p>
        <p>{row.reviewed_by} · {new Date(row.created_at).toLocaleString('ko-KR')}</p>
        <p className="whitespace-pre-wrap break-words">{row.comment}</p>
        {row.revoked_review_id !== null && <p>철회 대상 기록: #{row.revoked_review_id}</p>}
        <details className="break-all text-xs"><summary>참조 검토 당시 자료 정보</summary>
          <p>대상: {row.case_ids.join(', ')}</p><p>기준: {row.rubric_version}</p><p>평가 자료: {row.fixture_sha256}</p><p>실행 명세: {row.execution_spec_sha256}</p>
        </details>
      </article>)}
    </details>
  </section>
}
