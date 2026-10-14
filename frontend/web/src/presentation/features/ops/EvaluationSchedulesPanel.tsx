import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { createEvaluationSchedule, getEvaluationSchedules, getLiveReadiness, OpsApiError, pauseEvaluationSchedule } from '../../../data/ops/opsApi'
import type { EvaluationSchedule, LiveReadiness, EvaluationCatalog, ScheduleInput, SchedulesPage } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'
import { ScheduleRuntimeCheck } from './ScheduleRuntimeCheck'

const field = 'min-h-11 w-full rounded-xl border border-line bg-white px-3 text-sm'
const help = 'text-xs leading-5 text-ink-muted'
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
  const pauseHelpId = useId()
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
  return <article className="grid gap-3 rounded-xl border border-line p-4">
    <h3 className="font-bold">{label} · {row.state === 'paused' ? '중지됨' : row.state === 'expired' ? '기간 종료' : '승인된 계획'}</h3>
    <p className="text-sm">{row.starts_on} ~ {row.ends_on} · 서울 매일 {row.daily_at} · {row.request.live_config.model}</p>
    <p className="text-sm">회당 최대 {number(row.max_usage.calls)}회 / 입력 {number(row.max_usage.input_tokens)} / 출력 {number(row.max_usage.output_tokens)} 토큰</p>
    <p className="text-sm">승인 사유: {row.reason}</p>
    <Link className={styles.mutedLink} to={`/ops/evaluations/${row.request.reference_capture_id.slice(4)}`}>승인한 비교 기준 보기 · 버전 {row.request.baseline_version}</Link>
    {row.paused_at ? <p className="text-sm">중지 사유: {row.pause_reason}</p> : <div className="grid gap-2">
      <label className="text-sm">중지 사유<input aria-label={`${label} 계획 중지 사유`} aria-describedby={pauseHelpId} className={field} maxLength={500} value={reason} disabled={!!pending} onChange={(e) => setReason(e.target.value)} /></label>
      <p id={pauseHelpId} className={help}>이 계획의 앞으로의 접수를 중지하는 이유를 적으세요. 예: 답변 지침 변경으로 재검토가 필요함. 이미 접수된 실행의 취소와는 별개입니다.</p>
      {pending ? <><p className="text-sm">새 접수를 중지합니다. 이미 접수된 평가는 실행 상세에서 별도로 취소하세요.</p><button className={styles.secondaryButton} disabled={busy} onClick={() => void pause()}>확인한 계획 중지</button></>
        : <button className={styles.secondaryButton} disabled={!reason.trim()} onClick={() => setPending({ request_id: crypto.randomUUID(), reason: reason.trim() })}>계획 중지 내용 확인</button>}
    </div>}
    {row.occurrences.length === 0 ? <p className="text-sm text-ink-muted">아직 도래한 접수 기록이 없습니다.</p> : <ul className="grid gap-2 text-sm" aria-label="날짜별 접수 기록">{row.occurrences.map((item) => <li key={item.id}>
      {item.scheduled_on} · {item.status === 'BLOCKED' ? `접수 차단: ${reasons[item.reason_code] ?? item.reason_code}` : item.run_id
        ? <Link className={styles.mutedLink} to={`/ops/evaluations/${item.run_id}`}>실행 보기 · {item.run_status}</Link> : '접수 확인 중'}
    </li>)}</ul>}
  </article>
}

export function EvaluationSchedulesPanel({ owner, datasets, onExpired, refreshKey }: { owner: string; datasets: EvaluationCatalog['datasets']; onExpired: () => void; refreshKey: number }) {
  const helpId = useId()
  const eligible = datasets.filter((item) => item.live_config && item.execution_profiles.live)
  const [choice, setChoice] = useState(eligible[0]?.id ?? '')
  const selected = eligible.find((item) => item.id === choice) ?? eligible[0]
  const datasetId = selected?.id ?? ''
  const profile = selected?.execution_profiles.live
  const model = selected?.live_config?.model
  const [data, setData] = useState<SchedulesPage | null>(null)
  const [dataKey, setDataKey] = useState('')
  const [scheduleError, setScheduleError] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [check, setCheck] = useState<{ key: string; value: LiveReadiness | null; error: string } | null>(null)
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
  const [startsOn, setStartsOn] = useState(today)
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
  const schedulesKey = JSON.stringify([owner, page, revision, refreshKey])
  const readinessKey = JSON.stringify([owner, datasetId, profile, selected?.live_config, selected?.baseline, revision, refreshKey])
  const currentData = dataKey === schedulesKey ? data : null
  const readiness = check?.key === readinessKey ? check.value : null
  const readinessError = check?.key === readinessKey ? check.error : ''
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setScheduleError(''); setConsent(false)
    getEvaluationSchedules(page, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setData(value); setDataKey(schedulesKey) }
    }).catch((reason) => {
      if (controller.signal.aborted) return
      setScheduleError(message(reason))
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expired.current()
    })
    return () => controller.abort()
  }, [page, schedulesKey])
  useEffect(() => {
    const controller = new AbortController()
    setCheck(null); setConsent(false)
    if (profile && model) getLiveReadiness(datasetId, profile, controller.signal, model).then((value) => {
      if (!controller.signal.aborted) setCheck({ key: readinessKey, value, error: '' })
    }).catch((reason) => {
      if (controller.signal.aborted) return
      setCheck({ key: readinessKey, value: null, error: message(reason) })
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expired.current()
    })
    return () => controller.abort()
  }, [datasetId, profile, model, readinessKey])
  const days = (Date.parse(endsOn) - Date.parse(startsOn)) / 86400000 + 1
  const latestStart = new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10)
  const latestEnd = Number.isFinite(Date.parse(startsOn)) ? new Date(Date.parse(startsOn) + 30 * 86400000).toISOString().slice(0, 10) : latestStart
  const validDates = Number.isInteger(days) && days >= 1 && days <= 31 && startsOn >= today && startsOn <= latestStart
  const ready = !!(currentData?.enabled && selected?.baseline && readiness?.state === 'checked' && readiness.daily?.state === 'enforced'
    && readiness.remaining?.input_tokens != null && readiness.dataset_id === datasetId && readiness.execution_profile === profile && readiness.model === model)
  const pendingMatches = !!(pending && pending.dataset_id === datasetId && pending.execution_profile === profile
    && pending.reference_capture_id === selected?.baseline?.id && pending.baseline_version === selected?.baseline?.version
    && JSON.stringify(pending.live_config) === JSON.stringify(selected?.live_config))
  const canSave = !!pending && (!mayEdit || (ready && pendingMatches))
  const confirm = () => {
    if (!ready || !selected?.baseline || !selected.live_config || !profile || !consent || !reason.trim() || !validDates) return
    setSaved(false)
    setMayEdit(true)
    setPending({ request_id: crypto.randomUUID(), dataset_id: datasetId, reference_capture_id: selected.baseline.id,
      baseline_version: selected.baseline.version, live_config: selected.live_config, execution_profile: profile,
      confirm_paid_run: true, daily_at: dailyAt, starts_on: startsOn, ends_on: endsOn, reason: reason.trim() })
  }
  const save = async () => {
    if (!pending || sending.current || !canSave) return
    sending.current = true; setBusy(true); setError(''); setMayEdit(false)
    try { await createEvaluationSchedule(pending, owner); setPending(null); setConsent(false); setSaved(true); setRevision((value) => value + 1) }
    catch (error) { if (error instanceof OpsApiError && [400, 409].includes(error.status)) setMayEdit(true); handleError(error) }
    finally { sending.current = false; setBusy(false) }
  }
  return <section className={styles.card} aria-label="정기 평가 계획">
    <h2 className={styles.cardTitle}>정기 평가 계획</h2>
    <p className="text-sm leading-6 text-ink-muted">서울 시간 기준 하루 한 번, 최대 31일 동안 승인한 자료·모델·비교 기준으로 평가합니다. 예정 시각 이후 같은 날에 접수하며, 서버가 꺼져 놓친 과거 날짜는 실행하지 않습니다. 기준 변경·예산 부족·이전 실행 미완료 시 차단 기록을 남깁니다.</p>
    <ol aria-label="정기 계획 설정 순서" className="grid gap-3 rounded-xl bg-surface-muted p-4 text-sm lg:grid-cols-3">
      <li><p className="font-semibold">1. 자료와 비교 기준 확인</p><p className="mt-1 leading-6 text-ink-muted">반복해서 확인할 평가 자료를 고르고, 사람이 검토한 비교 기준과 고정 모델을 확인하세요.</p></li>
      <li><p className="font-semibold">2. 기간과 필요 예산 확인</p><p className="mt-1 leading-6 text-ink-muted">접수 시각·기간을 정하고 누적·일별 잔여량, 부족 조건과 연결 설정을 확인하세요. 먼저 짧은 기간으로 계획하는 편이 좋습니다.</p></li>
      <li><p className="font-semibold">3. 실행할 준비가 되면 승인</p><p className="mt-1 leading-6 text-ink-muted">실행할 때만 유료 실행에 동의하고 내용을 확인한 뒤 최종 저장하세요. 지금은 설명과 초안만 확인해도 됩니다.</p></li>
    </ol>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">정기 계획을 저장했습니다. 승인 기간에 예산과 검토 기준을 다시 확인한 후 접수합니다.</p>}
    <button className={styles.secondaryButton} onClick={() => setRevision((value) => value + 1)}>정기 계획 새로고침</button>
    <div className="@container/schedule">
      <div className="grid items-start gap-4 @min-[64rem]/schedule:grid-cols-2">
        <form className="grid min-w-0 gap-3 rounded-xl border border-line p-4" onSubmit={(event) => { event.preventDefault(); confirm() }}>
          <h3 className="font-bold">실행 조건 미리 설정</h3>
          <p className="text-sm text-ink-muted">입력한 내용은 이 화면의 초안입니다. 조건을 충족하고 최종 승인하기 전에는 저장되거나 실행되지 않으며, 페이지를 떠나면 초안이 사라집니다.</p>
          <fieldset disabled={!!pending} className="grid gap-3">
            <div className="grid gap-1"><label>정기 평가 자료<select aria-describedby={`${helpId}-dataset`} className={field} value={datasetId} disabled={!eligible.length} onChange={(e) => { setChoice(e.target.value); setConsent(false) }}>
              {!eligible.length && <option value="">선택 가능한 자료 없음</option>}{eligible.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label><p id={`${helpId}-dataset`} className={help}>매일 같은 질문·평가 조건으로 확인할 자료 묶음입니다. 새 모델 평가 설정이 등록된 자료만 표시되며, 선택만으로 실행되지는 않습니다.</p></div>
            {!eligible.length && <p role="status">새 모델 평가 설정이 있는 자료가 없습니다. 설정 항목을 확인하고 운영 담당자에게 자료 등록을 요청하세요.</p>}
            <div className="grid gap-1"><label>고정 모델<input aria-describedby={`${helpId}-model`} className={field} readOnly value={model ?? '선택 가능한 모델 없음'} /></label><p id={`${helpId}-model`} className={help}>선택한 자료에 등록된 새 평가 모델입니다. 이 화면에서는 바꿀 수 없으며, 저장한 계획이 다른 모델로 자동 전환되지는 않습니다. 새 모델·기준으로 계획하려면 기존 계획을 중지하고 새 계획을 승인하세요.</p></div>
            <div className="grid gap-1"><label>고정 비교 기준<input aria-describedby={`${helpId}-baseline`} className={field} readOnly value={selected?.baseline ? `${selected.baseline.label} · 버전 ${selected.baseline.version}` : '미지정'} /></label><p id={`${helpId}-baseline`} className={help}>새 결과와 비교할, 사람 검토를 거쳐 지정한 결과입니다. 미지정이면 평가 이력에서 먼저 지정하세요. 기준이나 검토·실행 설정이 달라지면 기존 계획의 새 접수가 차단됩니다.</p></div>
            {selected?.baseline?.id.startsWith('run:') && <Link className={styles.mutedLink} to={`/ops/evaluations/${selected.baseline.id.slice(4)}`}>선택된 비교 기준 보기</Link>}
            <div className="grid gap-1"><label>매일 접수 시각 · 서울<input aria-describedby={`${helpId}-time`} className={field} type="time" required value={dailyAt} onChange={(e) => setDailyAt(e.target.value)} /></label><p id={`${helpId}-time`} className={help}>서울 시간으로 평가 요청을 접수하기 시작할 시각입니다. 예: 09:00이면 그 시각 이후 처리기가 확인할 때 접수합니다. 실제 실행·완료 시각을 보장하지 않습니다.</p></div>
            <div className="grid gap-3 sm:grid-cols-2"><label>시작일<input aria-describedby={`${helpId}-dates`} className={field} type="date" required min={today} max={latestStart} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label><label>종료일<input aria-describedby={`${helpId}-dates`} className={field} type="date" required min={startsOn || today} max={latestEnd} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label></div>
            <p id={`${helpId}-dates`} className={help}>시작일은 서울 기준 오늘부터 30일 이내, 시작일·종료일을 모두 포함해 최대 31일입니다. 같은 날짜면 1일, 10월 15~17일이면 최대 3번의 평가입니다. 종료일 뒤에는 자동 연장되지 않습니다.</p>
            {!validDates && <p role="status">오늘부터 30일 안에 시작하는 1~31일 기간을 선택하세요.</p>}
            <div className="grid gap-1"><label>정기 계획 승인 사유<input aria-describedby={`${helpId}-reason`} className={field} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} /></label><p id={`${helpId}-reason`} className={help}>무엇을 확인하려는지와 승인 범위를 500자 이내로 남기세요. 예: 답변 지침 변경 후 H01~H06을 3일간 비교하고 결과를 매일 검토.</p></div>
            {readiness && <p className="text-sm">{model} · 회당 최대 {number(readiness.required.calls)}회 / 입력 {number(readiness.required.input_tokens)} / 출력 {number(readiness.required.output_tokens)} 토큰{Number.isInteger(days) && days > 0 && days <= 31 && <> · {days}일 전체 최대 {number(readiness.required.calls * days)}회 / 입력 {number(readiness.required.input_tokens * days)} / 출력 {number(readiness.required.output_tokens * days)} 토큰</>} · 실제 사용량·금액 견적이나 기간 전체 예약을 뜻하지 않습니다.</p>}
            {!ready && <p role="status">정기 접수 활성화·비교 기준·누적 입력 한도·일별 예산 점검이 모두 준비되어야 유료 실행 동의와 등록을 진행할 수 있습니다.</p>}
            <label className="flex items-start gap-2 text-sm"><input aria-describedby={`${helpId}-consent`} type="checkbox" disabled={!ready} checked={consent} onChange={(e) => setConsent(e.target.checked)} />선택한 평가 자료를 OpenAI에 전송하고 위 기간·모델·호출 및 토큰 상한 내의 유료 실행을 승인합니다.</label>
            <p id={`${helpId}-consent`} className={help}>체크만으로 저장되지는 않습니다. ‘정기 계획 내용 확인’ 다음 ‘확인한 정기 계획 저장’까지 누르면, 승인 기간에는 매번 다시 묻지 않고 조건을 확인해 접수합니다.</p>
            <button className={styles.secondaryButton} disabled={!ready || !consent || !reason.trim() || !validDates} type="submit">정기 계획 내용 확인</button>
          </fieldset>
        </form>
        <section className="grid min-w-0 gap-3 rounded-xl border border-line p-4 text-sm" aria-label="정기 평가 준비 상태">
          <h3 className="font-bold">정기 평가 준비 상태</h3>
          <p>자료 선택과 새로고침은 설정·예산을 조회만 합니다. 모델 호출·예산 예약·계획 등록은 발생하지 않습니다.</p>
          {scheduleError ? <p role="alert">정기 접수 상태 조회 실패: {scheduleError}</p> : !currentData ? <p role="status">정기 접수 상태를 확인하고 있습니다.</p>
            : <p>정기 접수: {currentData.enabled ? '활성화' : '비활성화 — 위의 정기 접수와 서버 유료 호출 허용 상태를 함께 확인하세요.'}</p>}
          <p>비교 기준: {selected?.baseline ? `지정됨 · ${selected.baseline.label} · 버전 ${selected.baseline.version}` : '미지정 — 평가 이력에서 사람 검토와 품질 판정을 통과한 기준을 먼저 지정하세요.'}</p>
          <p>설정·예산 점검: {!selected ? '조회할 자료 없음' : readinessError ? '조회 실패' : !readiness ? '조회 중' : readiness.state === 'checked' ? '조회 완료' : '조회 완료 · 부족 조건 있음'}</p>
          {readinessError && <p role="alert">{readinessError} 정기 계획 새로고침으로 다시 확인하세요.</p>}
          {readiness && <>
            <p className="text-xs text-ink-muted">조회 시각: {new Date(readiness.as_of).toLocaleString('ko-KR')} · 아래 잔여량은 조회 시점 기준입니다.</p>
            <div className="overflow-x-auto"><table className="w-full min-w-[32rem] text-left text-xs [&_th]:px-2 [&_th]:py-2 [&_td]:px-2 [&_td]:py-2 [&_tbody_tr]:border-t [&_tbody_tr]:border-line">
              <caption className="sr-only">회당 최대량과 누적·일별 예산</caption>
              <thead><tr><th scope="col">항목</th><th scope="col">회당 최대량</th><th scope="col">누적 잔여</th><th scope="col">일별 한도</th><th scope="col">오늘 일별 잔여 · 서울</th></tr></thead>
              <tbody>{([['calls', '호출'], ['input_tokens', '입력 토큰'], ['output_tokens', '출력 토큰']] as const).map(([key, label]) => <tr key={key}>
                <th scope="row">{label}</th><td>{number(readiness.required[key])}</td><td>{readiness.remaining?.[key] == null ? '확인 불가·미설정' : number(readiness.remaining[key])}</td>
                <td>{readiness.daily?.limits?.[key] == null ? '확인 불가·미설정' : number(readiness.daily.limits[key])}</td><td>{readiness.daily?.remaining?.[key] == null ? '확인 불가·미설정' : number(readiness.daily.remaining[key])}</td>
              </tr>)}</tbody>
            </table></div>
            {!readiness.remaining && <p>누적 잔여 한도를 확인할 수 없습니다. 예산 설정과 미확인 사용량을 확인하세요.</p>}
            {readiness.remaining?.input_tokens == null && <p>정기 계획에는 누적 입력 토큰 한도가 필수입니다. 미설정 또는 미확인 상태를 먼저 해결하세요.</p>}
            <p>일별 예산: {!readiness.daily ? '정보 없음 — 정기 계획에는 일별 한도가 필수입니다.' : readiness.daily.state === 'disabled' ? '미적용 — 정기 계획에는 일별 한도를 설정하고 적용해야 합니다.' : readiness.daily.state === 'unknown' ? '사용량 미확인 — 장부 확인이 필요합니다.' : readiness.daily.state === 'exceeded' ? '한도 초과 — 정산과 한도를 확인하세요.' : '적용 중 · 오늘 잔여량에는 이전 날짜에서 아직 해제되지 않은 예약도 반영됩니다.'}</p>
            {([['누적', readiness.remaining], ['오늘 일별', readiness.daily?.remaining]] as const).flatMap(([label, remaining]) => (['calls', 'input_tokens', 'output_tokens'] as const).map((key) => remaining?.[key] != null && remaining[key] < readiness.required[key]
              ? <p key={`${label}-${key}`}>{label} {key === 'calls' ? '호출' : key === 'input_tokens' ? '입력 토큰' : '출력 토큰'} 부족량: {number(readiness.required[key] - remaining[key])} · 회당 최대량 기준</p> : null))}
            {readiness.blockers.length > 0 && <ul className="list-disc pl-5 text-red-700" aria-label="정기 계획 차단 사유">{readiness.blockers.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>}
            {readiness.warnings.length > 0 && <ul className="list-disc pl-5 text-amber-800" aria-label="정기 계획 주의 사항">{readiness.warnings.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>}
          </>}
          <details className="rounded-lg bg-surface-muted p-3"><summary className="cursor-pointer font-semibold">예산 표 읽는 법과 한도 설정 기준</summary><dl className="mt-3 grid gap-3 text-xs leading-5">
            <div><dt className="font-semibold">호출 · 입력 토큰 · 출력 토큰</dt><dd>호출은 평가 중 모델·임베딩 API를 사용하는 횟수, 입력·출력 토큰은 보내고 받는 텍스트의 처리 단위입니다. 평가 1번이 API 호출 1회를 뜻하지는 않습니다.</dd></div>
            <div><dt className="font-semibold">회당 최대량</dt><dd>선택한 자료로 평가 1번을 접수할 때 확보해야 하는 최대량입니다. 매일 접수 시 예산을 예약하며, 기간 전체 최대량을 한 번에 예약하지 않습니다.</dd></div>
            <div><dt className="font-semibold">누적 잔여 · 오늘 일별 잔여</dt><dd>현재 추가 예약이 가능한 양입니다. 호출·입력·출력 각각에서 두 잔여량 모두 회당 최대량 이상이어야 합니다. 다른 평가도 같은 예산을 사용하므로 기간 전체 최대량과 다른 실행의 사용량을 함께 고려하세요.</dd></div>
            <div><dt className="font-semibold">일별 한도</dt><dd>서울 00:00~24:00에 허용하는 총량입니다. ‘예산 관리’에서 호출·입력·출력 한도를 정하고 일별 적용을 켜야 합니다. 누적 예산은 날짜가 바뀌어도 초기화되지 않습니다.</dd></div>
            <div><dt className="font-semibold">0 · 확인 불가·미설정</dt><dd>잔여량 0은 추가 예약할 수 있는 양이 없다는 뜻이고, 일별 한도 0은 그 항목에 허용한 양이 없다는 뜻입니다. 확인 불가·미설정은 0이나 무제한이 아니며 설정·사용량 확인이 필요합니다. 여기의 수치는 달러 비용이나 OpenAI 결제 한도가 아닙니다.</dd></div>
          </dl></details>
          <p className="flex flex-wrap gap-4"><Link className={styles.mutedLink} to="/ops/budget">예산 관리에서 한도 확인</Link><Link className={styles.mutedLink} to="/ops/evaluations">평가 이력에서 비교 기준 확인</Link></p>
          <p className="text-xs text-ink-muted">이 점검은 실행 승인이 아니며 모델 API 연결·실행기 상태·비교 기준의 검토 품질을 검사하지 않습니다. 등록과 매일 접수 시 서버가 조건을 다시 검증합니다.</p>
        </section>
      </div>
    </div>
    {pending && <div className="grid gap-2 rounded-xl border border-line p-4" role="region" aria-label="정기 계획 최종 확인"><p>{pending.starts_on} ~ {pending.ends_on} · 서울 {pending.daily_at} · 기준 버전 {pending.baseline_version} · {pending.reason}</p><p className="text-sm">한도가 부족하면 해당 날짜는 실행하지 않습니다. 중지 전까지 매일 이 승인 조건을 사용합니다.</p><button className={styles.primaryButton} disabled={busy || !canSave} onClick={() => void save()}>{busy ? '저장 확인 중…' : '확인한 정기 계획 저장'}</button>{mayEdit && !busy && <button className={styles.secondaryButton} onClick={() => { setPending(null); setConsent(false); setError('') }}>정기 계획 수정</button>}{!mayEdit && !busy && <p className="text-sm">응답을 받지 못한 승인 요청을 같은 식별자로 재시도합니다. 서버가 저장 여부와 신규 접수 조건을 다시 검증합니다.</p>}{error && <p className="text-sm">재시도는 같은 요청으로 확인합니다. 조건을 바꾸기 전 목록에서 기존 계획의 접수 여부를 확인하세요.</p>}</div>}
    <ScheduleRuntimeCheck onExpired={onExpired} />
    {currentData && <>
      <details className="rounded-xl border border-line p-4 text-sm"><summary className="cursor-pointer font-semibold">등록된 계획과 날짜별 접수 기록 읽는 법</summary><dl className="mt-3 grid gap-3 leading-6">
        <div><dt className="font-semibold">승인된 계획 · 중지됨 · 기간 종료</dt><dd className="text-ink-muted">계획의 승인·중지·기간 상태입니다. ‘승인된 계획’이어도 접수 설정·예산·비교 기준 조건을 충족해야 하며, 실행 성공을 뜻하지는 않습니다.</dd></div>
        <div><dt className="font-semibold">접수 차단 · 접수 확인 중 · 실행 보기</dt><dd className="text-ink-muted">접수 차단은 표시된 조건으로 해당 날짜의 평가가 접수되지 않았다는 뜻이며, 답변 품질 불합격과는 다릅니다. 차단된 날짜는 조건을 고쳐도 당일 자동 재접수하지 않습니다. 접수 확인 중이면 새로고침해 확인하고, 실행 보기가 생기면 상세에서 진행 상태와 결과를 확인하세요.</dd></div>
        <div><dt className="font-semibold">계획 중지와 실행 취소</dt><dd className="text-ink-muted">계획 중지는 앞으로의 새 접수를 막습니다. 중지한 계획은 재개할 수 없으며 새 계획을 승인해야 합니다. 같은 자료의 기간 종료 계획도 중지 후 교체하세요. 이미 접수된 평가는 실행 상세에서 별도로 취소하며, 놓친 과거 날짜의 평가를 나중에 몰아서 실행하지 않습니다.</dd></div>
      </dl></details>
      <div className="grid gap-3">{currentData.results.map((row) => <ScheduleRow key={row.id} row={row} owner={owner} label={datasets.find((item) => item.id === row.dataset_id)?.label ?? row.dataset_id} onSaved={() => setRevision((value) => value + 1)} onError={handleError} />)}</div>
      {currentData.total === 0 && <p className="text-sm">등록된 정기 계획이 없습니다.</p>}
      {currentData.total > 25 && <nav aria-label="정기 계획 페이지"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>이전</button> {page}페이지 <button disabled={page * 25 >= currentData.total} onClick={() => setPage((value) => value + 1)}>다음</button></nav>}
    </>}
  </section>
}
