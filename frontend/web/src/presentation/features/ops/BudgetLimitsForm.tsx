import { useRef, useState } from 'react'
import { OpsApiError, setBudgetLimits, type BudgetLimitsInput, type BudgetSummary } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const amount = (value: number | null | undefined, unit: string) => value == null ? '미설정' : `${value.toLocaleString('ko-KR')}${unit}`

export function BudgetLimitsForm({ summary, owner, onSaved, onExpired }: {
  summary: BudgetSummary; owner: string; onSaved: () => void; onExpired: () => void
}) {
  const [opened, setOpened] = useState(false)
  const [calls, setCalls] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [reason, setReason] = useState('')
  const [revision, setRevision] = useState('')
  const [previous, setPrevious] = useState(summary.limits)
  const [proposal, setProposal] = useState<BudgetLimitsInput | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const open = () => {
    setCalls(summary.limits?.calls.toString() ?? '')
    setInput(summary.limits?.input_tokens?.toString() ?? '')
    setOutput(summary.limits?.output_tokens.toString() ?? '')
    setPrevious(summary.limits); setRevision(summary.limits_revision!); setReason('')
    setProposal(null); setError(''); setOpened(true)
  }
  const review = () => {
    const valid = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    if (!valid(calls) || !valid(output) || (input !== '' && !valid(input)) || !reason.trim() || reason.trim().length > 1000) {
      setError('0 이상의 정수 한도와 변경 사유를 입력하세요.'); return
    }
    setProposal({ request_id: crypto.randomUUID(), expected_revision: revision,
      calls: Number(calls), output_tokens: Number(output), input_tokens: input === '' ? null : Number(input), reason: reason.trim() })
    setError('')
  }
  const save = async () => {
    if (!proposal || submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try {
      await setBudgetLimits(proposal, owner)
      setOpened(false); onSaved()
    } catch (failure) {
      if (failure instanceof OpsApiError && [401, 403].includes(failure.status)) onExpired()
      setError(failure instanceof Error ? failure.message : '한도 저장 결과를 확인하지 못했습니다.')
    } finally { submitting.current = false; setBusy(false) }
  }
  if (!summary.limits_revision) return null
  return <section aria-label="누적 한도 설정" className="space-y-3 border-t border-sample-border pt-4">
    <button className={styles.secondaryButton} disabled={busy || summary.state === 'inconsistent'} onClick={open}>누적 한도 설정</button>
    {opened && <>
      <p className="text-sm">과거 반영분과 앞으로 사용할 몫을 포함한 전체 누적 한도입니다. 사용량을 초기화하거나 모델 호출을 활성화하지 않습니다.</p>
      {error && <p role="alert">{error}</p>}
      {!proposal ? <form className="grid gap-3 text-sm sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); review() }}>
        <label className="grid gap-1">호출 누적 한도<input className="rounded border p-2" inputMode="numeric" value={calls} onChange={(event) => setCalls(event.target.value)} required /></label>
        <label className="grid gap-1">출력 토큰 누적 한도<input className="rounded border p-2" inputMode="numeric" value={output} onChange={(event) => setOutput(event.target.value)} required /></label>
        <label className="grid gap-1">입력 토큰 누적 한도<input className="rounded border p-2" inputMode="numeric" value={input} onChange={(event) => setInput(event.target.value)} required={previous?.input_tokens != null} /></label>
        <p className="text-xs text-sample-muted">입력 한도는 과거 미확인 기록을 해결한 뒤 설정할 수 있습니다. 최초 미설정은 빈칸으로 두며, 활성화 후에는 해제할 수 없습니다.</p>
        <label className="grid gap-1 sm:col-span-2">한도 변경 사유<textarea className="rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} required /></label>
        <button className={styles.primaryButton} type="submit">변경 내용 확인</button>
        <button className={styles.secondaryButton} type="button" onClick={() => setOpened(false)}>닫기</button>
      </form> : <div className="space-y-3 rounded-xl bg-[#f3f7f5] p-4 text-sm">
        <p>호출: {amount(previous?.calls, '회')} → {amount(proposal.calls, '회')}</p>
        <p>입력: {amount(previous?.input_tokens, '토큰')} → {amount(proposal.input_tokens, '토큰')}</p>
        <p>출력: {amount(previous?.output_tokens, '토큰')} → {amount(proposal.output_tokens, '토큰')}</p>
        <p>사유: {proposal.reason}</p>
        <p>로그인한 관리자 계정으로 변경 이력이 저장됩니다. 다른 운영자의 변경과 이미 할당된 사용량은 저장 시 다시 확인합니다.</p>
        <div className="flex flex-wrap gap-3">
          <button className={styles.primaryButton} disabled={busy} onClick={() => void save()}>{busy ? '저장 중…' : '확인한 한도 저장'}</button>
          <button className={styles.secondaryButton} disabled={busy} onClick={() => setOpened(false)}>닫기</button>
        </div>
        {error && <p>결과가 불확실하면 위 저장 버튼으로 같은 요청을 재확인할 수 있습니다. 조건을 바꾸려면 먼저 예산을 새로고침하세요.</p>}
      </div>}
    </>}
  </section>
}
