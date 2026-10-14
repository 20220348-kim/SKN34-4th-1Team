import { useId, useRef, useState } from 'react'
import { OpsApiError, setBudgetLimits, type BudgetLimitsInput, type BudgetSummary } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const amount = (value: number | null | undefined, unit: string) => value == null ? '미설정' : `${value.toLocaleString('ko-KR')}${unit}`

export function BudgetLimitsForm({ summary, owner, onSaved, onExpired }: {
  summary: BudgetSummary; owner: string; onSaved: () => void; onExpired: () => void
}) {
  const helpId = useId()
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
  return <section aria-label="누적 한도 설정" className="space-y-3 border-t border-line pt-4">
    <button className={styles.secondaryButton} disabled={busy || summary.state === 'inconsistent'} onClick={open}>누적 한도 설정</button>
    {opened && <>
      <p className="text-sm">추가 충전량이 아닌 전체 누적 상한을 입력하세요. 현재 할당량에 추가 평가의 최대 예약량을 더해 정합니다. 예: 현재 20회 할당 + 추가 6회 예약 = 호출 한도 26회.</p>
      <p className="text-xs text-ink-muted">이미 할당된 양보다 낮게 저장할 수 없습니다. 한도 저장은 사용량을 초기화하거나 유료 평가·정기 실행을 켜지 않습니다.</p>
      {error && <p role="alert">{error}</p>}
      {!proposal ? <form className="grid gap-3 text-sm sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); review() }}>
        <div className="space-y-1">
          <label className="grid gap-1">호출 누적 한도<input className="rounded border p-2" inputMode="numeric" value={calls} onChange={(event) => setCalls(event.target.value)} aria-describedby={`${helpId}-calls`} required /></label>
          <p id={`${helpId}-calls`} className="text-xs text-ink-muted">답변 생성·임베딩 등에 사용하는 API 호출의 총횟수입니다. 평가 횟수나 질문 수를 뜻하지 않습니다. RAG 평가는 문서·질문 임베딩과 답변 호출을 합합니다.</p>
        </div>
        <div className="space-y-1">
          <label className="grid gap-1">출력 토큰 누적 한도<input className="rounded border p-2" inputMode="numeric" value={output} onChange={(event) => setOutput(event.target.value)} aria-describedby={`${helpId}-output`} required /></label>
          <p id={`${helpId}-output`} className="text-xs text-ink-muted">모델이 생성하는 답변 등 출력 분량의 총상한입니다. 평가별 최대 출력량을 합산해 정합니다.</p>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="grid gap-1">입력 토큰 누적 한도<input className="rounded border p-2" inputMode="numeric" value={input} onChange={(event) => setInput(event.target.value)} aria-describedby={`${helpId}-input`} required={previous?.input_tokens != null} /></label>
          <p id={`${helpId}-input`} className="text-xs text-ink-muted">질문·지침·근거 등 모델에 보내는 분량의 총상한입니다. 토큰은 문자 수와 다릅니다. 과거 미확인 입력 기록을 해결한 뒤 설정할 수 있습니다. 최초 미설정은 빈칸으로 두며, 한 번 설정하면 해제할 수 없습니다. 숫자 0은 미설정이 아닌 한도 0입니다.</p>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="grid gap-1">한도 변경 사유<textarea className="rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} aria-describedby={`${helpId}-reason`} maxLength={1000} required /></label>
          <p id={`${helpId}-reason`} className="text-xs text-ink-muted">평가 목적·범위와 한도를 정한 근거를 남기세요. 예: “검토 자료 H01~H06 답변 평가 1회분을 현재 할당량에 추가”.</p>
        </div>
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
