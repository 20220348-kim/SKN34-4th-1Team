import { useEffect, useId, useRef, useState } from 'react'
import { getScheduleSettings, OpsApiError, setScheduleSettings, type ScheduleSettings, type ScheduleSettingsInput } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles, workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'

type Props = { owner: string; onExpired: () => void; onSaved: () => void; refreshKey?: number }
const label = (enabled: boolean) => enabled ? '활성' : '비활성'

export function ScheduleSettingsPanel(props: Props) {
  // 다른 관리자 계정에서 이전 계정의 변경 확인·요청을 재사용하지 않는다.
  return <ScheduleSettingsForm key={props.owner} {...props} />
}

function ScheduleSettingsForm({ owner, onExpired, onSaved, refreshKey }: Props) {
  const helpId = useId()
  const [settings, setSettings] = useState<ScheduleSettings | null>(null)
  const [selected, setSelected] = useState(false)
  const [reason, setReason] = useState('')
  const [proposal, setProposal] = useState<ScheduleSettingsInput | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const submitting = useRef(false)
  const mutation = useRef<AbortController | null>(null)

  useEffect(() => () => mutation.current?.abort(), [])
  useEffect(() => {
    // 결과가 불확실한 저장은 화면 새로고침보다 같은 요청의 재확인을 우선한다.
    if (proposal) return
    const controller = new AbortController()
    setLoading(true); setSettings(null)
    void getScheduleSettings(controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setSettings(value); setSelected(value.enabled)
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      if (failure instanceof OpsApiError && [401, 403].includes(failure.status)) onExpired()
      setError(failure instanceof Error ? failure.message : '정기 접수 설정을 조회하지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload, refreshKey, proposal, onExpired])

  const review = () => {
    if (!settings || loading || selected === settings.enabled || !reason.trim() || reason.trim().length > 500) return
    setError(''); setNotice(''); setUncertain(false)
    setProposal({ request_id: crypto.randomUUID(), expected_revision: settings.revision, enabled: selected, reason: reason.trim() })
  }
  const save = async () => {
    if (!proposal || !settings || submitting.current || loading) return
    const controller = new AbortController()
    mutation.current = controller
    submitting.current = true; setBusy(true); setError('')
    try {
      const value = await setScheduleSettings(proposal, owner, controller.signal)
      if (controller.signal.aborted) return
      setSettings(value); setSelected(value.enabled); setProposal(null); setReason(''); setUncertain(false)
      setNotice(`정기 접수 ${label(value.change.enabled)} 변경을 확인했습니다. 현재 정기 접수는 ${label(value.enabled)}입니다. 유료 실행 설정은 변경하지 않았습니다.`)
      onSaved()
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof OpsApiError && [401, 403].includes(failure.status)) onExpired()
      if (failure instanceof OpsApiError && failure.status === 409) {
        setProposal(null); setReason(''); setUncertain(false); setReload((value) => value + 1)
        setError('설정이 다른 요청에 의해 변경되었습니다. 최신 상태를 불러온 뒤 변경할 상태와 사유를 다시 확인하세요.')
      } else if (failure instanceof OpsApiError && failure.status === 400) {
        setProposal(null); setUncertain(false)
        setError('변경할 상태와 500자 이내의 변경 사유를 확인한 뒤 다시 제출하세요.')
      } else {
        setUncertain(true)
        setError(failure instanceof Error ? failure.message : '저장 결과를 확인하지 못했습니다.')
      }
    } finally {
      submitting.current = false
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return <section aria-label="정기 접수 활성화 설정" className="space-y-4 rounded-xl border border-line bg-white p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold">정기 실행 활성화 설정</h2>
      <button type="button" className={styles.secondaryButton} disabled={loading || busy || proposal !== null} onClick={() => { setError(''); setNotice(''); setReload((value) => value + 1) }}>설정 새로고침</button>
    </div>
    <p>이 설정은 정기 계획의 새 평가 접수만 허용하거나 중지합니다. 실제 유료 모델 호출 허용, 예산, 계획은 바꾸지 않습니다.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">정기 접수 설정을 불러오는 중…</p>}
    {!loading && settings && <>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div><dt className="text-ink-muted">정기 접수</dt><dd className="mt-1 space-y-2"><span className={workspaceTagClassName(settings.enabled ? 'ok' : 'muted')}>{label(settings.enabled)}</span><p className="text-xs text-ink-muted">승인된 정기 계획을 새 평가로 접수할지 정합니다. 아래에서 관리자가 변경할 수 있습니다.</p></dd></div>
        <div><dt className="text-ink-muted">실제 유료 모델 호출</dt><dd className="mt-1 space-y-2"><p className="font-semibold">{settings.live_enabled ? '서버에서 허용됨' : '서버에서 차단됨'}</p><p className="text-xs text-ink-muted">실제 모델 API 호출을 허용하는 서버 설정입니다. 정기 접수와 별개이며 이 화면에서는 변경하지 않습니다.</p></dd></div>
        <div><dt className="text-ink-muted">RAG 유료 평가</dt><dd className="mt-1 space-y-2"><p className="font-semibold">{settings.rag_live_enabled ? '서버에서 허용됨' : '서버에서 차단됨'}</p><p className="text-xs text-ink-muted">검색과 답변 생성을 함께 평가하는 RAG 경로의 추가 서버 설정입니다. 실제 유료 모델 호출 허용도 함께 필요합니다.</p></dd></div>
      </dl>
      <p className="text-xs text-ink-muted">설정 출처: {settings.source === 'environment' ? '서버 초기 설정' : '관리자 저장 설정'} · 변경 버전 {settings.revision}. 실제 유료 실행 허용은 운영 담당자가 서버에서 별도로 관리합니다.</p>
      {!proposal ? <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); review() }}>
        <div className="space-y-1 sm:col-span-2">
        <label className="grid gap-1">변경할 정기 접수 상태<select className="rounded border p-2" aria-describedby={`${helpId}-state`} value={selected ? 'enabled' : 'disabled'} onChange={(event) => setSelected(event.target.value === 'enabled')}>
          <option value="disabled">비활성 — 새 정기 평가 접수 중지</option><option value="enabled">활성 — 조건을 충족한 정기 평가 접수 허용</option>
        </select></label>
        <p id={`${helpId}-state`} className="text-xs text-ink-muted">준비 중에는 비활성을 유지하세요. 활성으로 저장하면 이미 승인된 계획이 다음 점검부터 접수될 수 있습니다. 비활성은 새 접수만 막으며 실행 중인 평가는 취소하지 않습니다. 선택만으로 저장되지는 않습니다.</p>
        </div>
        <div className="space-y-1 sm:col-span-2">
        <label className="grid gap-1">정기 접수 변경 사유<textarea className="rounded border p-2" aria-describedby={`${helpId}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required /></label>
        <p id={`${helpId}-reason`} className="text-xs text-ink-muted">변경 목적을 500자 이내로 적으세요. 예: “비교 기준과 일별 예산 확인을 마쳐 접수 허용”, “점검 기간 동안 새 접수 중지”. 관리자 계정과 함께 변경 이력에 저장됩니다. 내용 확인 후 최종 저장해야 반영됩니다.</p>
        </div>
        <button type="submit" className={styles.primaryButton} disabled={selected === settings.enabled || !reason.trim()}>정기 접수 변경 내용 확인</button>
      </form> : <div className="space-y-3 rounded-xl bg-surface-muted p-4" aria-label="정기 접수 변경 확인">
        <p className="font-semibold">정기 접수: {label(settings.enabled)} → {label(proposal.enabled)}</p>
        <p>변경 사유: {proposal.reason}</p>
        <p>{proposal.enabled
          ? '기존에 승인한 계획이 있다면 정기 처리기의 다음 확인부터 도래한 일정이 접수될 수 있습니다. 실제 실행에는 서버의 유료 실행 허용·비교 기준·예산 조건이 모두 필요합니다.'
          : '새로운 정기 평가 접수를 중지합니다. 이미 접수되었거나 실행 중인 평가는 취소되지 않습니다. 개별 계획의 일시 중지 상태도 바꾸지 않습니다.'}</p>
        <p>이 저장으로 실제 유료 실행을 켜거나 예산·계획을 등록하지 않습니다. 관리자 계정과 변경 사유를 이력에 남깁니다.</p>
        {uncertain && <p className="text-amber-800">저장이 반영되었을 수 있습니다. 아래 버튼은 같은 요청 번호와 내용으로 결과를 재확인합니다. 확인 전에는 다른 변경을 제출하지 마세요.</p>}
        <div className="flex flex-wrap gap-3">
          <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void save()}>{busy ? '정기 접수 설정 저장 중…' : uncertain ? '같은 요청으로 저장 결과 재확인' : '확인한 정기 접수 설정 저장'}</button>
          <button type="button" className={styles.secondaryButton} disabled={busy || uncertain} onClick={() => setProposal(null)}>변경 내용 다시 작성</button>
        </div>
      </div>}
      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer font-semibold">최근 정기 접수 설정 변경 이력 ({settings.changes.length}건)</summary>
        {settings.changes.length ? <ul className="mt-3 space-y-3">{settings.changes.map((change) => <li className="rounded border border-line p-3" key={change.request_id}>
          <p>버전 {change.revision} · {label(change.previous_enabled)} → {label(change.enabled)}</p>
          <p className="mt-1">{change.reason}</p>
          <p className="mt-1 text-xs text-ink-muted">관리자 {change.actor} · {new Date(change.created_at).toLocaleString('ko-KR')}</p>
        </li>)}</ul> : <p className="mt-2 text-ink-muted">아직 관리자가 저장한 변경 이력이 없습니다.</p>}
      </details>
    </>}
  </section>
}
