import { useRef, useState } from 'react'
import { OpsApiError, setDailyBudgetLimits, type DailyBudget, type DailyBudgetLimitsInput } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

export function DailyBudgetLimitsForm({ daily, owner, onSaved, onExpired }: {
  daily: DailyBudget | undefined; owner: string; onSaved: () => void; onExpired: () => void
}) {
  const [opened, setOpened] = useState(false)
  const [disable, setDisable] = useState(false)
  const [calls, setCalls] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [reason, setReason] = useState('')
  const [revision, setRevision] = useState('')
  const [previous, setPrevious] = useState(daily)
  const [proposal, setProposal] = useState<DailyBudgetLimitsInput | null>(null)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  if (!daily?.limits_revision) return null
  // A successful write may have lost its response: keep that exact request retryable.
  const stale = !attempted && revision !== daily.limits_revision
  const open = () => {
    setPrevious(daily); setRevision(daily.limits_revision!); setDisable(false)
    setCalls(daily.limits?.calls.toString() ?? '')
    setInput(daily.limits?.input_tokens.toString() ?? '')
    setOutput(daily.limits?.output_tokens.toString() ?? '')
    setReason(''); setProposal(null); setError(''); setConflict(false); setAttempted(false); setOpened(true)
  }
  const review = () => {
    if (stale || conflict) return
    const valid = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    if ((!disable && ![calls, input, output].every(valid)) || !reason.trim() || reason.trim().length > 1000) {
      setError('호출·입력·출력에 0 이상의 정수 한도와 변경 사유를 입력하세요.'); return
    }
    const shared = { request_id: crypto.randomUUID(), expected_revision: revision, reason: reason.trim() }
    setProposal(disable ? { ...shared, disable: true, calls: null, input_tokens: null, output_tokens: null }
      : { ...shared, disable: false, calls: Number(calls), input_tokens: Number(input), output_tokens: Number(output) })
    setError('')
  }
  const save = async () => {
    if (!proposal || submitting.current || stale || conflict) return
    submitting.current = true; setBusy(true); setAttempted(true); setError('')
    try {
      await setDailyBudgetLimits(proposal, owner)
      setOpened(false); onSaved()
    } catch (failure) {
      if (failure instanceof OpsApiError && [401, 403].includes(failure.status)) onExpired()
      if (failure instanceof OpsApiError && failure.status === 409) setConflict(true)
      setError(failure instanceof Error ? failure.message : '일별 한도 저장 결과를 확인하지 못했습니다.')
    } finally { submitting.current = false; setBusy(false) }
  }
  const amount = (value: number | undefined) => value === undefined ? '미설정' : value.toLocaleString('ko-KR')
  return <section aria-label="일별 한도 설정" className="space-y-3 border-t border-line pt-4">
    <button type="button" className={styles.secondaryButton} disabled={opened || busy} onClick={open}>일별 한도 설정</button>
    {opened && <>
      <p className="text-sm">서울 시간의 예약 접수일 기준으로 매일 적용하는 한도입니다. 누적 한도와 함께 검사하며 사용량을 초기화하거나 모델 호출을 활성화하지 않습니다.</p>
      {error && <p role="alert">{error}</p>}
      {(stale || conflict) && <p role="alert">일별 정책을 다시 확인해야 합니다. 예산 새로고침 후 변경 내용을 다시 작성하세요.</p>}
      {!proposal ? <form className="grid gap-3 text-sm sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); review() }}>
        <label className="grid gap-1 sm:col-span-2">일별 정책 변경<select className="rounded border p-2" value={disable ? 'disable' : 'enable'} disabled={stale || conflict} onChange={(event) => setDisable(event.target.value === 'disable')}>
          <option value="enable">한도 설정·적용</option><option value="disable" disabled={!previous?.limits || previous.state === 'disabled'}>일별 제한 해제</option>
        </select></label>
        {!disable && <>
          <label className="grid gap-1">일별 호출 한도<input className="rounded border p-2" inputMode="numeric" value={calls} disabled={stale || conflict} onChange={(event) => setCalls(event.target.value)} required /></label>
          <label className="grid gap-1">일별 입력 토큰 한도<input className="rounded border p-2" inputMode="numeric" value={input} disabled={stale || conflict} onChange={(event) => setInput(event.target.value)} required /></label>
          <label className="grid gap-1">일별 출력 토큰 한도<input className="rounded border p-2" inputMode="numeric" value={output} disabled={stale || conflict} onChange={(event) => setOutput(event.target.value)} required /></label>
        </>}
        <label className="grid gap-1 sm:col-span-2">일별 한도 변경 사유<textarea className="rounded border p-2" value={reason} disabled={stale || conflict} onChange={(event) => setReason(event.target.value)} maxLength={1000} required /></label>
        <button className={styles.primaryButton} type="submit" disabled={stale || conflict}>일별 변경 내용 확인</button>
        <button className={styles.secondaryButton} type="button" onClick={() => setOpened(false)}>일별 설정 닫기</button>
      </form> : <div className="space-y-3 rounded-xl bg-[#f3f7f5] p-4 text-sm">
        <p>일별 제한: {previous?.state === 'disabled' ? '미적용' : '적용 중'} → {proposal.disable ? '해제' : '적용'}</p>
        {proposal.disable ? <p>일별 제한을 해제하면 누적 한도만 적용됩니다. 기존 예약·미확정 사용량·변경 이력은 유지됩니다.</p>
          : (['calls', 'input_tokens', 'output_tokens'] as const).map((key) => <p key={key}>{({ calls: '호출', input_tokens: '입력 토큰', output_tokens: '출력 토큰' })[key]}: {amount(previous?.limits?.[key])} → {amount(proposal[key])}</p>)}
        <p>사유: {proposal.reason}</p>
        <p>로그인한 관리자 계정으로 기록하며, 저장 시 최신 정책과 오늘 할당량·전날 이월량을 다시 검사합니다.</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={styles.primaryButton} disabled={busy || stale || conflict} onClick={() => void save()}>{busy ? '저장 중…' : '확인한 일별 정책 저장'}</button>
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setOpened(false)}>일별 설정 닫기</button>
        </div>
        {error && !conflict && <p>응답을 확인하지 못했다면 위 저장 버튼으로 같은 요청을 재확인하세요.</p>}
      </div>}
    </>}
  </section>
}
