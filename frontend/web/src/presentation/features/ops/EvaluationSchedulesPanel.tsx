import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { createEvaluationSchedule, getEvaluationSchedules, getLiveReadiness, OpsApiError, pauseEvaluationSchedule } from '../../../data/ops/opsApi'
import type { EvaluationSchedule, LiveReadiness, OpsSession, ScheduleInput, SchedulesPage } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const field = 'min-h-11 w-full rounded-xl border border-sample-border bg-white px-3 text-sm'
const message = (error: unknown) => error instanceof Error ? error.message : '정기 계획을 확인하지 못했습니다.'
const number = (value: number) => value.toLocaleString('ko-KR')
const reasons: Record<string, string> = {
  MISSED_SCHEDULE_DAY: '접수 전 날짜가 지나 실행하지 않았습니다.',
  SCHEDULE_CLOSED: '계획이 중지되었거나 승인 기간이 끝났습니다.',
  SCHEDULE_DISABLED: '정기 실행 또는 새 모델 평가가 비활성화되어 있습니다.',
  SCHEDULE_BUDGET_UNAVAILABLE: '유효한 누적·일별 예산이 필요합니다.',
  PREVIOUS_RUN_UNFINISHED: '이 자료의 이전 실행이 아직 끝나지 않았습니다.',
  PREVIOUS_BUDGET_UNSETTLED: '이전 실행의 사용량 정산이 끝나지 않았습니다.',
  LIVE_BUDGET_UNAVAILABLE: '최대 호출량을 예약할 예산이 부족합니다.',
  BASELINE_OR_PROFILE_CHANGED: '비교 기준·검토 또는 실행 설정이 변경되었습니다.',
  EXECUTION_PROFILE_CHANGED: '실행 설정이 변경되었습니다.',
  RESULTS_UNAVAILABLE: '비교 기준의 저장 자료를 확인할 수 없습니다.',
  EVALUATION_ADMISSION_PAUSED: '새 평가 접수가 중지되어 있습니다.',
  EVALUATION_ADMISSION_UNAVAILABLE: '새 평가 접수 상태를 확인할 수 없습니다.',
}

function ScheduleRow({ row, label, owner, onSaved, onError }: { row: EvaluationSchedule; label: string; owner: string; onSaved: () => void; onError: (error: unknown) => void }) {
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState<{ request_id: string; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const pause = async () => {
    if (!pending || sending.current) return
    sending.current = true; setBusy(true)
    try { await pauseEvaluationSchedule(row.id, pending, owner); setPending(null); onSaved() }
    catch (error) { onError(error) }
    finally { sending.current = false; setBusy(false) }
  }
  return <article className="grid gap-3 rounded-xl border border-sample-border p-4">
    <h3 className="font-bold">{label} · {row.state === 'paused' ? '중지됨' : row.state === 'expired' ? '기간 종료' : '승인된 계획'}</h3>
    <p className="text-sm">{row.starts_on} ~ {row.ends_on} · 서울 매일 {row.daily_at} · {row.request.live_config.model}</p>
    <p className="text-sm">회당 최대 {number(row.max_usage.calls)}회 / 입력 {number(row.max_usage.input_tokens)} / 출력 {number(row.max_usage.output_tokens)} 토큰</p>
    <p className="text-sm">승인 사유: {row.reason}</p>
    <Link className={styles.mutedLink} to={`/ops/evaluations/${row.request.reference_capture_id.slice(4)}`}>승인한 비교 기준 보기 · 버전 {row.request.baseline_version}</Link>
    {row.paused_at ? <p className="text-sm">중지 사유: {row.pause_reason}</p> : <div className="grid gap-2">
      <label className="text-sm">중지 사유<input aria-label={`${label} 계획 중지 사유`} className={field} maxLength={500} value={reason} disabled={!!pending} onChange={(e) => setReason(e.target.value)} /></label>
      {pending ? <><p className="text-sm">새 접수를 중지합니다. 이미 접수된 평가는 실행 상세에서 별도로 취소하세요.</p><button className={styles.secondaryButton} disabled={busy} onClick={() => void pause()}>확인한 계획 중지</button></>
        : <button className={styles.secondaryButton} disabled={!reason.trim()} onClick={() => setPending({ request_id: crypto.randomUUID(), reason: reason.trim() })}>계획 중지 내용 확인</button>}
    </div>}
    {row.occurrences.length === 0 ? <p className="text-sm text-sample-muted">아직 도래한 접수 기록이 없습니다.</p> : <ul className="grid gap-2 text-sm" aria-label="날짜별 접수 기록">{row.occurrences.map((item) => <li key={item.id}>
      {item.scheduled_on} · {item.status === 'BLOCKED' ? `접수 차단: ${reasons[item.reason_code] ?? item.reason_code}` : item.run_id
        ? <Link className={styles.mutedLink} to={`/ops/evaluations/${item.run_id}`}>실행 보기 · {item.run_status}</Link> : '접수 확인 중'}
    </li>)}</ul>}
  </article>
}

export function EvaluationSchedulesPanel({ owner, datasets, onExpired, refreshKey }: { owner: string; datasets: OpsSession['datasets']; onExpired: () => void; refreshKey: number }) {
  const eligible = datasets.filter((item) => item.baseline && item.live_config && item.execution_profiles.live)
  const [datasetId, setDatasetId] = useState(eligible[0]?.id ?? '')
  const selected = eligible.find((item) => item.id === datasetId)
  const [data, setData] = useState<SchedulesPage | null>(null)
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [readiness, setReadiness] = useState<LiveReadiness | null>(null)
  const [startsOn, setStartsOn] = useState(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()))
  const [endsOn, setEndsOn] = useState(startsOn)
  const [dailyAt, setDailyAt] = useState('09:00')
  const [reason, setReason] = useState('')
  const [consent, setConsent] = useState(false)
  const [pending, setPending] = useState<ScheduleInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mayEdit, setMayEdit] = useState(true)
  const sending = useRef(false)
  const expired = useRef(onExpired)
  expired.current = onExpired
  const handleError = (error: unknown) => {
    if (error instanceof OpsApiError && [401, 403].includes(error.status)) expired.current()
    else setError(message(error))
  }
  useEffect(() => {
    const controller = new AbortController()
    getEvaluationSchedules(page, controller.signal).then((value) => { setData(value); setError('') }).catch((reason) => {
      if (!controller.signal.aborted) handleError(reason)
    })
    return () => controller.abort()
  }, [page, revision, refreshKey, owner])
  const profile = selected?.execution_profiles.live
  useEffect(() => {
    const controller = new AbortController()
    setReadiness(null)
    if (profile && data?.enabled) getLiveReadiness(datasetId, profile, controller.signal).then(setReadiness).catch((reason) => {
      if (!controller.signal.aborted) handleError(reason)
    })
    return () => controller.abort()
  }, [datasetId, profile, data?.enabled, refreshKey, revision])
  const days = (Date.parse(endsOn) - Date.parse(startsOn)) / 86400000 + 1
  const ready = data?.enabled && readiness?.state === 'checked' && readiness.daily?.state === 'enforced'
    && readiness.remaining?.input_tokens != null && readiness.dataset_id === datasetId
  const confirm = () => {
    if (!ready || !selected?.baseline || !selected.live_config || !profile || !consent || !reason.trim() || !Number.isInteger(days) || days < 1 || days > 31) return
    setSaved(false)
    setMayEdit(true)
    setPending({ request_id: crypto.randomUUID(), dataset_id: datasetId, reference_capture_id: selected.baseline.id,
      baseline_version: selected.baseline.version, live_config: selected.live_config, execution_profile: profile,
      confirm_paid_run: true, daily_at: dailyAt, starts_on: startsOn, ends_on: endsOn, reason: reason.trim() })
  }
  const save = async () => {
    if (!pending || sending.current) return
    sending.current = true; setBusy(true); setError(''); setMayEdit(false)
    try { await createEvaluationSchedule(pending, owner); setPending(null); setConsent(false); setSaved(true); setRevision((value) => value + 1) }
    catch (error) { if (error instanceof OpsApiError && [400, 409].includes(error.status)) setMayEdit(true); handleError(error) }
    finally { sending.current = false; setBusy(false) }
  }
  return <section className={styles.card} aria-label="정기 평가 계획">
    <h2 className={styles.cardTitle}>정기 평가 계획</h2>
    <p className="text-sm leading-6 text-sample-muted">서울 시간 기준 하루 한 번, 최대 31일 동안 승인한 자료·모델·비교 기준으로 평가합니다. 예정 시각 이후 같은 날에 접수하며, 서버가 꺼져 놓친 과거 날짜는 실행하지 않습니다. 기준 변경·예산 부족·이전 실행 미완료 시 차단 기록을 남깁니다.</p>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">정기 계획을 저장했습니다. 승인 기간에 예산과 검토 기준을 다시 확인한 후 접수합니다.</p>}
    <button className={styles.secondaryButton} onClick={() => setRevision((value) => value + 1)}>정기 계획 새로고침</button>
    {!data ? <p role="status">정기 계획을 확인하고 있습니다.</p> : <>
      {!data.enabled ? <p role="status">정기 접수가 비활성화되어 있습니다. 운영 설정과 승인된 비교 기준·누적 및 일별 예산이 필요합니다.</p>
        : eligible.length === 0 ? <p role="status">사람 검토와 품질 판정을 통과한 비교 기준을 먼저 지정하세요.</p> : <>
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); confirm() }}>
            <fieldset disabled={!!pending} className="grid gap-3">
              <label>정기 평가 자료<select className={field} value={datasetId} onChange={(e) => { setDatasetId(e.target.value); setConsent(false) }}>{eligible.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label>매일 접수 시각 · 서울<input className={field} type="time" required value={dailyAt} onChange={(e) => setDailyAt(e.target.value)} /></label>
              <div className="grid gap-3 sm:grid-cols-2"><label>시작일<input className={field} type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label><label>종료일<input className={field} type="date" required value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label></div>
              <label>정기 계획 승인 사유<input className={field} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              {readiness && <p className="text-sm">{selected?.live_config?.model} · 회당 최대 {number(readiness.required.calls)}회 / 입력 {number(readiness.required.input_tokens)} / 출력 {number(readiness.required.output_tokens)} 토큰{Number.isInteger(days) && days > 0 && days <= 31 && <> · {days}일 전체 최대 {number(readiness.required.calls * days)}회 / 입력 {number(readiness.required.input_tokens * days)} / 출력 {number(readiness.required.output_tokens * days)} 토큰</>}</p>}
              {!ready && <p role="status">누적 입력 한도와 일별 예산을 포함한 실행 조건 점검이 통과해야 계획을 승인할 수 있습니다.</p>}
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />선택한 평가 자료를 OpenAI에 전송하고 위 기간·모델·호출 및 토큰 상한 내의 유료 실행을 승인합니다.</label>
              <button className={styles.secondaryButton} disabled={!ready || !consent || !reason.trim() || days < 1 || days > 31} type="submit">정기 계획 내용 확인</button>
            </fieldset>
          </form>
          {pending && <div className="grid gap-2 rounded-xl border border-sample-border p-4" role="region" aria-label="정기 계획 최종 확인"><p>{pending.starts_on} ~ {pending.ends_on} · 서울 {pending.daily_at} · 기준 버전 {pending.baseline_version} · {pending.reason}</p><p className="text-sm">한도가 부족하면 해당 날짜는 실행하지 않습니다. 중지 전까지 매일 이 승인 조건을 사용합니다.</p><button className={styles.primaryButton} disabled={busy} onClick={() => void save()}>{busy ? '저장 확인 중…' : '확인한 정기 계획 저장'}</button>{mayEdit && !busy && <button className={styles.secondaryButton} onClick={() => { setPending(null); setConsent(false); setError('') }}>정기 계획 수정</button>}{error && <p className="text-sm">재시도는 같은 요청으로 확인합니다. 조건을 바꾸기 전 목록에서 기존 계획의 접수 여부를 확인하세요.</p>}</div>}
        </>}
      <div className="grid gap-3">{data.results.map((row) => <ScheduleRow key={row.id} row={row} owner={owner} label={datasets.find((item) => item.id === row.dataset_id)?.label ?? row.dataset_id} onSaved={() => setRevision((value) => value + 1)} onError={handleError} />)}</div>
      {data.total === 0 && <p className="text-sm">등록된 정기 계획이 없습니다.</p>}
      {data.total > 25 && <nav aria-label="정기 계획 페이지"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>이전</button> {page}페이지 <button disabled={page * 25 >= data.total} onClick={() => setPage((value) => value + 1)}>다음</button></nav>}
    </>}
  </section>
}
