import { useEffect, useRef, useState } from 'react'
import { clearEvaluationBaseline, getEvaluationReview, OpsApiError, promoteEvaluationBaseline, saveEvaluationCaseReview, saveEvaluationReview } from '../../../data/ops/opsApi'
import type { CaseReviewDecision, EvaluationReview } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles, workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'
import { QualityReviewPanel } from './QualityReviewPanel'
import { EvaluationReviewProgress } from './EvaluationReviewProgress'

export function EvaluationReviewPanel({ runId, onExpired, onChanged }: { runId: string; onExpired: () => void; onChanged: () => void }) {
  const [data, setData] = useState<EvaluationReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [comment, setComment] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [fixtureDirty, setFixtureDirty] = useState(false)
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [caseDrafts, setCaseDrafts] = useState<Record<string, { decision: CaseReviewDecision | ''; comment: string }>>({})
  const expiry = useRef(onExpired); expiry.current = onExpired
  const inFlight = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    getEvaluationReview(runId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setData(value); setError(''); setLoadFailed(false); setConflict(false); setConfirmed(false); setCaseDrafts({}) }
    }).catch((reason) => {
      if (controller.signal.aborted) return
      setLoadFailed(true)
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(reason instanceof Error ? reason.message : '검토 자료를 불러오지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [runId, refresh])
  const latest = data?.reviews[0]
  const hasDrafts = Object.keys(caseDrafts).length > 0
  const hasUnsaved = hasDrafts || fixtureDirty || comment !== '' || confirmed
  const locked = busy || loading || loadFailed || conflict || confirmRefresh
  const reload = () => {
    if (busy || loading) return
    setConfirmRefresh(false); setCaseDrafts({}); setFixtureDirty(false); setComment(''); setConfirmed(false)
    setNotice(''); setLoading(true); setRefresh((value) => value + 1)
  }
  const stamp = () => ({ capture_sha256: data!.material!.capture_sha256, fixture_sha256: data!.material!.fixture_sha256, rubric_version: data!.rubric.version, review_version: data!.review_version })
  const caseLabel = (decision: CaseReviewDecision) => ({ SUITABLE: '적합', UNSUITABLE: '부적합', DEFERRED: '판단 보류' })[decision]
  const saveCase = async (caseId: string) => {
    const draft = caseDrafts[caseId]
    if (inFlight.current || locked || fixtureDirty || !data?.material || !draft?.decision || !draft.comment.trim()) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const value = await saveEvaluationCaseReview(runId, caseId, draft.decision, draft.comment.trim(), stamp())
      setData(value); setConfirmed(false)
      setCaseDrafts((drafts) => Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== caseId)))
      setNotice(`${caseId} 사례 검토를 저장했습니다.`); onChanged()
    } catch (reason) {
      if (reason instanceof OpsApiError && reason.status === 409) setConflict(true)
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(reason instanceof Error ? reason.message : '사례 검토를 저장하지 못했습니다.')
    } finally { inFlight.current = false; setBusy(false) }
  }
  const mutate = async (decision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'CLEAR') => {
    if (inFlight.current || locked || fixtureDirty || !data || (decision !== 'CLEAR' && !data.material) || (!decision && !latest)) return
    if (decision !== 'CLEAR' && hasDrafts) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const value = decision === 'CLEAR'
        ? await clearEvaluationBaseline(runId, data.baseline_version, comment.trim())
        : decision
        ? await saveEvaluationReview(runId, decision, comment.trim(), stamp())
        : await promoteEvaluationBaseline(runId, latest!.id, data.baseline_version)
      setData(value); setConfirmed(false); setComment(''); onChanged()
      setNotice(decision === 'CLEAR' ? '비교 기준을 해제했습니다.' : decision ? '검토 기록을 저장했습니다.' : '이 데이터셋의 비교 기준으로 지정했습니다.')
    } catch (reason) {
      if (reason instanceof OpsApiError && reason.status === 409) setConflict(true)
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(reason instanceof Error ? reason.message : '검토를 저장하지 못했습니다.')
    } finally { inFlight.current = false; setBusy(false) }
  }
  return <section className={styles.card} aria-label="응답 검토와 기준 지정">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className={styles.cardTitle}>응답 검토와 기준 지정</h2><button className={styles.secondaryButton} disabled={busy || loading || confirmRefresh} onClick={() => hasUnsaved ? setConfirmRefresh(true) : reload()}>검토 새로고침</button></div>
    <p className={styles.cardDescription}>선택된 모든 사례의 질문·근거·후보 답변을 검토합니다. 검토 승인은 이 실행에 대한 관리자 판단이며, AI 작성 참조 자료를 사람이 작성한 정답으로 바꾸거나 의미 충실도 점수를 생성하지 않습니다.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-primary">{notice}</p>}
    {confirmRefresh && <section aria-label="검토 입력 취소 확인" className="grid gap-3 rounded-xl bg-amber-50 p-4 text-sm">
      <p>저장하지 않은 사례 판단·기준 자료 검토·전체 의견이 사라집니다. 입력을 버리고 최신 검토 기록을 불러올까요? 서버에 저장된 기록은 유지됩니다.</p>
      <div className="flex flex-wrap gap-3"><button type="button" className={styles.secondaryButton} onClick={() => setConfirmRefresh(false)}>계속 작성</button><button type="button" className={styles.secondaryButton} onClick={reload}>입력 버리고 새로고침</button></div>
    </section>}
    {loading && data && <p role="status" className="text-sm">최신 검토 자료를 불러오는 동안 저장을 중지합니다.</p>}
    {loadFailed && <p className="text-sm text-amber-800">최신 검토 자료를 확인하지 못했습니다. 새로고침에 성공한 뒤 판단을 저장하세요.</p>}
    {conflict && <p className="text-sm text-amber-800">다른 검토나 자료 변경이 있습니다. 입력은 보존했으며 저장을 중지했습니다. 검토 새로고침으로 최신 기록을 확인한 뒤 다시 판단하세요.</p>}
    {!data ? loading && <p role="status">검토 자료를 불러오고 있습니다.</p> : <>
      {data.material?.data_type === 'official-html-snapshot' && <p className="rounded-xl bg-amber-50 p-3 text-sm">실제 공고에서 저장한 HTML 근거입니다. 수집 당시 본문만 포함하며 첨부파일과 현재 공고의 변경 내용은 포함하지 않습니다. 참조 조건은 AI 작성 자료이므로 원문을 대조한 사람 검토가 필요합니다.</p>}
      {data.material?.candidate_origin === 'historical-answer-projection' && <p className="rounded-xl bg-slate-50 p-3 text-sm">과거 저장 응답 · {data.material.recorded_model} · {data.material.recorded_at ? new Date(data.material.recorded_at).toLocaleString('ko-KR') : '시각 미기록'}. 이번에 생성한 응답이나 현재 모델의 성능 측정이 아닙니다. 검색 품질은 이 평가에 포함하지 않습니다.</p>}
      {data.material?.reference_revision && <section aria-label="참조 조건 변경 내용" className="grid gap-2 rounded-xl bg-amber-50 p-4 text-sm">
        <h3 className="font-bold">참조 조건을 보완한 새 평가 자료</h3>
        <p>{data.material.reference_revision.reason}</p>
        <p>변경 사례: {data.material.reference_revision.changed_case_ids.join(', ')} · 이전 자료: {data.material.reference_revision.previous_dataset_id}</p>
        <blockquote className="border-l-2 border-amber-400 pl-3">{data.material.reference_revision.source_quote}</blockquote>
        <p>공고 원문과 과거 답변은 유지했습니다. 이전 자료의 승인·비교 기준은 이 버전에 승계되지 않으므로 기준 자료와 사례를 다시 검토하세요.</p>
      </section>}
      <EvaluationReviewProgress data={data} hasDrafts={hasDrafts} disabled={locked || !!error} onNavigate={(target) => {
        const element = document.getElementById(target)
        if (element instanceof HTMLDetailsElement) element.open = true
        element?.focus(); element?.scrollIntoView({ block: 'start' })
      }} />
      <QualityReviewPanel key={`${runId}:${refresh}`} runId={runId} data={data} busy={locked || hasDrafts} onBusy={setBusy} onDirty={setFixtureDirty} onConflict={() => setConflict(true)} onExpired={onExpired} onSaved={(value) => { setData(value); setConfirmed(false); onChanged() }} />
      <p><span className={workspaceTagClassName(data.approval_current ? 'ok' : 'info')}>{data.approval_current ? '검토 승인' : latest?.decision === 'APPROVED' ? '이전 승인 · 사례별 재검토 필요' : latest ? '수정 필요' : '미검토'}</span>{data.is_baseline && <span className="ml-3 text-sm font-semibold text-brand-primary">현재 데이터셋의 비교 기준</span>}</p>
      {data.baseline_requires_review && <p className="rounded-xl bg-amber-50 p-3 text-sm">검토 또는 품질 재판정이 필요한 기존 기준입니다. 유효한 품질 합격과 전체 승인을 완료하기 전에는 새 평가의 기준으로 사용할 수 없습니다. 과거 평가 기록은 유지됩니다.</p>}
      <div className="rounded-xl bg-slate-50 p-4 text-sm"><p className="font-semibold">사례별 검토 기준 · {data.rubric.version}</p><ul className="mt-2 list-disc space-y-1 pl-5">{data.rubric.criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul><p className="mt-2">필수 사례 모두를 적합으로 저장해야 전체 승인할 수 있습니다. 판단 보류와 미검토는 적합으로 처리하지 않습니다.</p></div>
      {data.material_error && <p role="alert" className="text-sm text-red-700">{data.material_error}</p>}
      {data.material?.cases.map((item) => {
        const history = data.case_reviews.filter((review) => review.case_id === item.case_id)
        const current = history[0]
        const valid = current?.capture_sha256 === data.material?.capture_sha256 && current?.fixture_sha256 === data.material?.fixture_sha256 && current?.rubric_version === data.rubric.version
        const draft = caseDrafts[item.case_id] ?? { decision: valid ? current.decision : '', comment: valid ? current.comment : '' }
        return <article id={`case-review-${item.case_id}`} tabIndex={-1} key={item.case_id} style={{ scrollMarginTop: 'calc(var(--workspace-header-h, 0px) + 1rem)' }} className="grid gap-4 rounded-xl border border-line p-4">
        <h3 className="font-bold">{item.case_id} · {item.question}</h3>
        <p className="text-xs text-ink-muted">{item.document_title}</p>
        {item.source && <div className="grid gap-1 text-xs text-ink-muted"><a className="underline" href={item.source.url} target="_blank" rel="noreferrer">공고 출처 보기</a><p>원문 수집: {new Date(item.source.collected_at).toLocaleString('ko-KR')} · 저장한 HTML 본문 · 첨부 미포함</p><details><summary>저장 원문 검증 정보</summary><p className="break-all">HTML SHA-256: {item.source.html_sha256}</p><p className="break-all">본문 SHA-256: {item.source.content_sha256}</p></details></div>}
        <div className="grid gap-4 md:grid-cols-2"><div className="rounded-xl bg-[#f3f7f5] p-4"><h4 className="mb-2 text-sm font-bold">후보 답변</h4><p className="whitespace-pre-wrap text-sm leading-7">{item.answer}</p><p className="mt-3 text-xs">상태: {item.answer_status} · 인용 청크: {item.cited_orders.join(', ') || '없음'}</p></div><div className="rounded-xl bg-slate-50 p-4"><h4 className="mb-2 text-sm font-bold">기존 기준 답변</h4><p className="whitespace-pre-wrap text-sm leading-7">{item.reference_answer}</p></div></div>
        <details open><summary className="cursor-pointer text-sm font-semibold">제공한 근거 청크</summary><div className="mt-3 grid gap-3">{item.evidence.map((chunk) => <div key={chunk.order} className="border-l-2 border-brand-primary pl-3 text-sm leading-6"><strong>청크 {chunk.order}{item.cited_orders.includes(chunk.order) ? ' · 후보가 인용함' : ''}</strong><p className="whitespace-pre-wrap">{chunk.text}</p></div>)}</div></details>
        <details><summary className="cursor-pointer text-sm font-semibold">AI 작성 참조 조건</summary><div className="mt-3 grid gap-2 text-sm leading-6"><p>예상 상태: {item.expected_status} · 예상 인용 청크: {item.expected_citation_orders.join(', ') || '없음'}</p><p>포함할 사실: {item.reference_facts.join(' / ')}</p><p>포함하면 안 되는 주장: {item.forbidden_claims.join(' / ')}</p></div></details>
        <div className="grid gap-3 border-t border-line pt-4"><p className="text-sm font-semibold">저장된 판단: {valid ? caseLabel(current.decision) : current ? '자료 또는 검토 기준 변경 · 재검토 필요' : '미검토'}</p>
          <label className="grid gap-2 text-sm">{item.case_id} 판단<select className="rounded-xl border border-line p-3" value={draft.decision} disabled={locked || fixtureDirty} onChange={(event) => setCaseDrafts((values) => ({ ...values, [item.case_id]: { ...draft, decision: event.target.value as CaseReviewDecision | '' } }))}><option value="">판단 선택</option><option value="SUITABLE">적합</option><option value="UNSUITABLE">부적합</option><option value="DEFERRED">판단 보류</option></select></label>
          <label className="grid gap-2 text-sm">{item.case_id} 판단 사유<textarea className="rounded-xl border border-line p-3" rows={2} maxLength={3000} value={draft.comment} disabled={locked || fixtureDirty} onChange={(event) => setCaseDrafts((values) => ({ ...values, [item.case_id]: { ...draft, comment: event.target.value } }))} /></label>
          <button className={`${styles.secondaryButton} justify-self-start`} disabled={locked || fixtureDirty || !caseDrafts[item.case_id] || !draft.decision || !draft.comment.trim()} onClick={() => void saveCase(item.case_id)}>{item.case_id} 검토 저장</button>
          {!!history.length && <details><summary className="cursor-pointer text-sm">{item.case_id} 검토 이력 · {history.length}건</summary><ol className="mt-2 space-y-2">{history.map((review) => <li key={review.id} className="rounded-xl bg-slate-50 p-3 text-sm"><p>{caseLabel(review.decision)} · {review.reviewed_by} · {new Date(review.created_at).toLocaleString('ko-KR')}</p><p className="whitespace-pre-wrap">{review.comment}</p></li>)}</ol></details>}
        </div>
      </article>})}
      {(data.material || data.is_baseline) && <div id="overall-review" tabIndex={-1} style={{ scrollMarginTop: 'calc(var(--workspace-header-h, 0px) + 1rem)' }} className="grid gap-3">
        <label className="grid gap-2 text-sm font-semibold">검토 의견<textarea rows={3} maxLength={3000} className="w-full rounded-xl border border-line p-3 font-normal" value={comment} disabled={locked || fixtureDirty} onChange={(event) => setComment(event.target.value)} placeholder="근거와 답변을 대조한 판단과 남은 문제를 기록하세요." /></label>
        {data.material && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={locked || fixtureDirty} onChange={(event) => setConfirmed(event.target.checked)} />위 모든 사례의 질문·근거·후보 답변을 검토했습니다.</label>}
        {hasDrafts && <p className="text-sm text-amber-800">저장하지 않은 사례 판단이 있습니다. 먼저 사례 검토를 저장하세요.</p>}
        <div className="flex flex-wrap gap-3"><button className={styles.primaryButton} disabled={locked || fixtureDirty || hasDrafts || !data.can_approve || !data.material || !confirmed || !comment.trim()} onClick={() => void mutate('APPROVED')}>검토 승인 저장</button><button className={styles.secondaryButton} disabled={locked || fixtureDirty || hasDrafts || !data.material || !confirmed || !comment.trim()} onClick={() => void mutate('CHANGES_REQUESTED')}>수정 필요 저장</button><button className={styles.secondaryButton} disabled={locked || fixtureDirty || hasDrafts || !data.material || data.is_baseline || !data.approval_current || !data.can_promote} onClick={() => void mutate()}>비교 기준으로 지정</button>{data.is_baseline && <button className={styles.secondaryButton} disabled={locked || fixtureDirty || !comment.trim()} onClick={() => void mutate('CLEAR')}>의견을 사유로 기준 해제</button>}</div>
        <p className="text-xs leading-5 text-ink-muted">기준 지정은 같은 자료의 다음 평가에 적용됩니다. 기존 기준이 있으면 교체되며, 이미 접수한 평가의 기준은 유지됩니다. 새 검토를 저장하면 이 실행의 기준 지정이 해제됩니다.</p>
      </div>}
      {!!data.baseline_history.length && <details><summary className="cursor-pointer text-sm font-semibold">데이터셋 기준 변경 이력 · {data.baseline_history.length}건</summary><ol className="mt-3 grid gap-3">{data.baseline_history.map((item) => <li key={item.version} className="rounded-xl bg-slate-50 p-3 text-sm"><p className="font-semibold">버전 {item.version} · {item.run_id ? item.previous_run_id ? '교체' : '지정' : '해제'} · {item.changed_by} · {new Date(item.created_at).toLocaleString('ko-KR')}</p><p className="break-all">{item.previous_run_id ?? '기준 없음'} → {item.run_id ?? '기준 없음'}</p><p className="mt-2 whitespace-pre-wrap">{item.reason}</p></li>)}</ol></details>}
      {!!data.reviews.length && <details open><summary className="cursor-pointer text-sm font-semibold">검토 이력 · {data.reviews.length}건</summary><ol className="mt-3 grid gap-3">{data.reviews.map((review) => <li key={review.id} className="rounded-xl bg-slate-50 p-3 text-sm"><p className="font-semibold">{review.decision === 'APPROVED' ? '검토 승인' : '수정 필요'} · {review.reviewed_by} · {new Date(review.created_at).toLocaleString('ko-KR')}</p><p className="mt-2 whitespace-pre-wrap">{review.comment}</p></li>)}</ol></details>}
    </>}
  </section>
}
