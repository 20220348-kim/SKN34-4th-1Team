import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { applyLegacyUsage, getLegacyUsagePreview, getUnaccountedRuns, OpsApiError, type LegacyUsageInput, type LegacyUsagePreview, type UnaccountedRuns } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const date = (value: string) => new Date(value).toLocaleString('ko-KR')
const amounts = (value: { calls: number; input_tokens: number; output_tokens: number }) =>
  `${value.calls.toLocaleString('ko-KR')}회 · 입력 ${value.input_tokens.toLocaleString('ko-KR')} / 출력 ${value.output_tokens.toLocaleString('ko-KR')}토큰`

export function UnaccountedRunsPanel({ onExpired, refreshKey, operatorId, onApplied }: { onExpired: () => void; refreshKey: number; operatorId?: string; onApplied?: () => void }) {
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<UnaccountedRuns | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<LegacyUsagePreview | null>(null)
  const [listError, setListError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setListError(''); setSelected(null); setPreview(null); setPreviewError('')
    void getUnaccountedRuns(page, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result)
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setListError(reason instanceof Error ? reason.message : '미반영 실행을 불러오지 못했습니다.')
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
    })
    return () => controller.abort()
  }, [page, refresh, refreshKey])
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    setPreview(null); setPreviewError('')
    void getLegacyUsagePreview(selected, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPreview(result)
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setPreviewError(reason instanceof Error ? reason.message : '저장된 사용량을 확인하지 못했습니다.')
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
    })
    return () => controller.abort()
  }, [selected])
  return <section aria-label="미반영 실행 검토" className="space-y-4 border-t border-line pt-4">
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">미반영 실행 검토</h3><button className={styles.secondaryButton} onClick={() => setRefresh((value) => value + 1)}>미반영 목록 새로고침</button></div>
    <p className="text-sm text-ink-muted">예약과 사용량 반영 기록이 없는 모델 실행입니다. 목록에 있다는 이유만으로 과거 사용량 반영 대상이 되는 것은 아닙니다.</p>
    {listError && <p role="alert">{listError}</p>}
    {!data && !listError && <p role="status">미반영 실행을 불러오고 있습니다.</p>}
    {data && <>
      <p className="text-xs text-ink-muted">조회 {date(data.as_of)} · 전체 {data.count.toLocaleString('ko-KR')}건</p>
      {!data.results.length ? <p>미반영 실행이 없습니다.</p> : <ul className="space-y-3">{data.results.map((run) => <li key={run.run_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#f3f7f5] p-3 text-sm">
        <div><Link className="text-brand-primary underline" to={`/ops/evaluations/${run.run_id}`}>{run.dataset_label} · {run.run_id.slice(0, 8)}</Link><p>{run.status_label} · {date(run.created_at)}</p></div>
        <button className={styles.secondaryButton} aria-label={`사용량 확인 ${run.run_id}`} onClick={() => { setPreview(null); setPreviewError(''); setSelected(run.run_id) }} disabled={selected === run.run_id}>사용량 확인</button>
      </li>)}</ul>}
      {(data.count > 25 || page > 1) && <nav aria-label="미반영 실행 페이지" className="flex justify-end gap-3 text-sm">
        <button className={styles.secondaryButton} disabled={page === 1} onClick={() => setPage((value) => value - 1)}>미반영 이전</button><span>{page}페이지</span><button className={styles.secondaryButton} disabled={!data.next} onClick={() => setPage((value) => value + 1)}>미반영 다음</button>
      </nav>}
    </>}
    {selected && <section aria-label="과거 사용량 미리보기" className="space-y-2 rounded-xl border border-line p-4 text-sm">
      <h4 className="font-semibold">저장 응답 사용량 확인 · {selected.slice(0, 8)}</h4>
      {previewError && <p role="alert">{previewError} 사용량을 0으로 판단할 수 없습니다. 목록을 새로고침해 다시 확인하세요.</p>}
      {!preview && !previewError && <p role="status">저장 결과의 연결과 전체 사용량을 검증하고 있습니다.</p>}
      {preview && <>
        <p className="text-xs text-ink-muted">검증 시각: {date(preview.as_of)}</p>
        {preview.state === 'unavailable' ? <p className="font-semibold text-amber-800">사용량 확인 불가 · 0으로 반영하지 않습니다.</p> : <>
          <p className="font-semibold">저장 응답 사용량: {amounts(preview.usage)}</p>
          {preview.before && preview.after && <><p>현재 전체 할당량: {amounts(preview.before)}</p><p>반영 시 예상 전체 할당량: {amounts(preview.after)}</p></>}
          <p>{preview.can_apply ? '현재 한도에서 반영 조건을 충족합니다. 운영자의 별도 검토·반영이 필요합니다.' : '사용량은 확인됐지만 현재 반영 조건을 충족하지 못했습니다.'}</p>
          <p className="break-all text-xs text-ink-muted">원본 SHA-256: {preview.capture_sha256}</p><p className="break-all text-xs text-ink-muted">검토 증거 SHA-256: {preview.evidence_sha256}</p>
        </>}
        {preview.blockers.length > 0 && <ul className="list-disc space-y-1 pl-5 text-amber-800">{preview.blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
        <p>이 확인은 장부 반영이나 한도 변경을 하지 않습니다. 저장 응답의 사용량이며 제공자 청구 확인·답변 품질 승인과 별개입니다.</p>
        {operatorId && preview.state === 'verified' && preview.can_apply && <LegacyApplyForm key={preview.run_id + preview.evidence_sha256} preview={preview} owner={operatorId} onExpired={onExpired} onApplied={() => { setSelected(null); setRefresh((value) => value + 1); onApplied?.() }} />}
      </>}
    </section>}
  </section>
}

function LegacyApplyForm({ preview, owner, onExpired, onApplied }: {
  preview: Extract<LegacyUsagePreview, { state: 'verified' }>; owner: string; onExpired: () => void; onApplied: () => void
}) {
  const [reason, setReason] = useState('')
  const [checked, setChecked] = useState(false)
  const [pending, setPending] = useState<LegacyUsageInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const apply = async () => {
    if (submitting.current || !checked || !reason.trim()) return
    const data = pending ?? { request_id: crypto.randomUUID(), evidence_sha256: preview.evidence_sha256, reason: reason.trim() }
    setPending(data); setBusy(true); setError(''); submitting.current = true
    try { await applyLegacyUsage(preview.run_id, data, owner); onApplied() }
    catch (failure) {
      if (failure instanceof OpsApiError && [401, 403].includes(failure.status)) onExpired()
      setError(failure instanceof Error ? failure.message : '반영 결과를 확인하지 못했습니다.')
    } finally { submitting.current = false; setBusy(false) }
  }
  return <form aria-label="과거 사용량 반영" className="space-y-3 border-t border-line pt-3" onSubmit={(event) => { event.preventDefault(); void apply() }}>
    <label className="grid gap-1">사용량 검토 사유<textarea className="rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} required disabled={pending !== null} /></label>
    <label className="flex items-start gap-2"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={pending !== null} />위 사용량과 출처를 확인했으며, 이 실행의 사용량을 누적 장부에 반영합니다.</label>
    {error && <p role="alert">{error} 반영 결과가 불확실하면 같은 요청으로 다시 확인하세요.</p>}
    <button className={styles.primaryButton} disabled={busy || !checked || !reason.trim()} type="submit">{busy ? '반영 중…' : pending ? '같은 반영 요청 재확인' : '검토한 사용량 반영'}</button>
    <p className="text-xs text-ink-muted">관리자 계정과 사유를 이력으로 남깁니다. 새 모델 호출과 한도 변경은 수행하지 않습니다.</p>
  </form>
}
