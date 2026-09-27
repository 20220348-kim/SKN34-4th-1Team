import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { getEvaluation, getOpsSession, listEvaluations, OpsApiError, submitEvaluation } from '../../../data/ops/opsApi'
import { appContainer } from '../../../app/appContainer'
import { useAppDispatch } from '../../../app/hooks'
import { signedOut } from '../../shared/auth/state/authSlice'
import { loginPathFor } from '../../shared/auth/returnPath'
import type { EvaluationPage, EvaluationRun, OpsSession } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles, workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'
import { EvaluationReviewPanel } from './EvaluationReviewPanel'
import { WorkspacePageHeader } from '../../shared/workspace/WorkspacePageHeader'

const listPath = '/ops/evaluations'
const notice = '저장된 과거 평가 결과를 비교합니다. 새 모델 호출은 없으며 현재 모델의 품질 측정이 아닙니다.'
const liveNotice = '선택한 가상 공고의 질문·고정 근거 청크와 답변 지침을 OpenAI에 전송해 새 응답을 생성합니다. 검색·임베딩은 실행하지 않으며 API 비용이 발생합니다.'
const field = 'min-h-11 w-full rounded-xl border border-sample-border bg-white px-3 text-sm focus:outline-2 focus:outline-brand-primary'
const date = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR') : '—'
const message = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'

function Status({ run }: { run: EvaluationRun }) {
  return <span className={workspaceTagClassName(run.error_code || ['FAILED', 'CRASHED', 'RESULT_ERROR'].includes(run.status) ? 'danger' : run.status === 'COMPLETED' ? 'ok' : 'info')}>{run.status_label}</span>
}

export function OpsApp() {
  useEffect(() => {
    const previous = document.title
    document.title = 'GovBiz · LLMOps 운영'
    return () => { document.title = previous }
  }, [])
  const dispatch = useAppDispatch()
  const [denied, setDenied] = useState(false)
  const [session, setSession] = useState<OpsSession | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [loggingOut, setLoggingOut] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const controller = new AbortController()
    getOpsSession(controller.signal).then((value) => {
      if (controller.signal.aborted) return
      if (!value.user) dispatch(signedOut())
      setSession(value); setDenied(false)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && reason.status === 401) {
        dispatch(signedOut()); setSession({ user: null, csrf_token: '', datasets: [], live_enabled: false })
      } else { setError(message(reason)); setDenied(reason instanceof OpsApiError && reason.status === 403) }
    })
    return () => controller.abort()
  }, [reload, dispatch])
  const expired = () => { setSession(null); setError(''); setReload((value) => value + 1) }
  const signOut = async () => {
    setLoggingOut(true)
    try {
      await appContainer.resolve('logOutUseCase').execute()
      dispatch(signedOut()); setSession(null); setError(''); setDenied(false)
      navigate(loginPathFor(location.pathname + location.search), { replace: true })
    }
    catch (reason) { setError(message(reason)) }
    finally { setLoggingOut(false) }
  }
  return <div className="min-h-dvh bg-[#f7f9f8] text-app-ink">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-sample-border bg-white px-[clamp(1rem,5vw,4.5rem)] py-4">
      <Link to={listPath} className="text-lg font-extrabold tracking-tight text-brand-primary">GovBiz <span className="ml-2 text-sm font-semibold text-sample-muted">LLMOps</span></Link>
      <nav aria-label="운영 메뉴" className="flex flex-wrap items-center gap-4 text-sm">
        <Link to="/" className={styles.mutedLink}>서비스 홈</Link>
        {(session?.user || denied) && <><span>{session?.user?.username}</span><button className={styles.secondaryButton} onClick={() => void signOut()} disabled={loggingOut}>로그아웃</button></>}
      </nav>
    </header>
    <main className="mx-auto max-w-[1240px]">
      {error && <div className="m-5 rounded-xl border border-red-200 bg-red-50 p-4" role="alert">{error} {!session && <button className={styles.secondaryButton} onClick={() => { setError(''); setReload((value) => value + 1) }}>연결 다시 확인</button>}</div>}
      {!session ? (!error && <p className="p-8" role="status">운영자 세션을 확인하고 있습니다.</p>)
        : !session.user ? <Navigate replace to={loginPathFor(location.pathname === '/ops/login' ? listPath : location.pathname + location.search)} />
          : <Routes>
            <Route path="/ops/evaluations" element={<EvaluationList key={session.user.username} datasets={session.datasets} liveEnabled={session.live_enabled} onExpired={expired} />} />
            <Route path="/ops/evaluations/:runId" element={<EvaluationDetail key={`${session.user.username}:${location.pathname}`} onExpired={expired} onReviewChanged={() => setReload((value) => value + 1)} />} />
            <Route path="*" element={<Navigate replace to={listPath} />} />
          </Routes>}
    </main>
  </div>
}

function EvaluationList({ datasets, liveEnabled, onExpired }: { datasets: OpsSession['datasets']; liveEnabled: boolean; onExpired: () => void }) {
  const [search, setSearch] = useSearchParams()
  const pageValue = Number(search.get('page') ?? 1)
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1
  const [data, setData] = useState<EvaluationPage | null>(null)
  const [error, setError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'replay' | 'live'>('replay')
  const [approved, setApproved] = useState(false)
  const [dataset, setDataset] = useState(datasets[0]?.id ?? '')
  const selected = datasets.find((item) => item.id === dataset)
  const [reference, setReference] = useState(datasets[0]?.baseline?.id ?? datasets[0]?.captures[0]?.id ?? '')
  const [candidate, setCandidate] = useState(datasets[0]?.captures.at(-1)?.id ?? '')
  const changeDataset = (id: string) => {
    const value = datasets.find((item) => item.id === id)
    setApproved(false); setDataset(id); setReference(value?.baseline?.id ?? value?.captures[0]?.id ?? ''); setCandidate(value?.captures.at(-1)?.id ?? '')
  }
  const requestId = useRef<string | null>(null)
  const submitting = useRef(false)
  const navigate = useNavigate()
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const controller = new AbortController()
    setError(''); setData(null)
    listEvaluations(page, controller.signal).then(setData).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && (reason.status === 401 || reason.status === 403)) expiry.current()
      else setError(message(reason))
    })
    return () => controller.abort()
  }, [page, refresh])
  const submit = async () => {
    if (submitting.current || (mode === 'live' && (!approved || !liveEnabled || !selected))) return
    submitting.current = true; setBusy(true); setSubmitError('')
    requestId.current ??= crypto.randomUUID()
    try {
      const run = await submitEvaluation(requestId.current, dataset, mode === 'live' ? 'new-model-response' : candidate, reference, mode === 'live' ? selected!.live_config : null)
      navigate(`${listPath}/${run.id}`)
    } catch (reason) {
      if (reason instanceof OpsApiError && (reason.status === 401 || reason.status === 403)) expiry.current()
      else setSubmitError(`${message(reason)} 재시도할 때 같은 요청을 사용합니다.`)
    } finally { submitting.current = false; setBusy(false) }
  }
  return <>
    <WorkspacePageHeader title="평가 실행 관리" actions={<button className={styles.secondaryButton} onClick={() => setRefresh((value) => value + 1)}>목록 새로고침</button>} />
    <div className={styles.content}>
      <section className={styles.card} aria-label="평가 실행">
        <p className={styles.sectionEyebrow}>LLMOps 평가</p><h2 className={styles.cardTitle}>지원 대상 근거 답변 평가</h2>
        <p className="text-sm leading-6 text-sample-muted">{mode === 'live' ? liveNotice : notice}</p>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <label className="grid w-full gap-2 text-sm font-semibold">실행 방식<select className={field} value={mode} disabled={busy || requestId.current !== null} onChange={(event) => { setMode(event.target.value as 'replay' | 'live'); setApproved(false) }}><option value="replay">저장 응답 재평가 · API 호출 없음</option><option value="live">새 응답 생성 · 유료 모델 호출</option></select></label>
          <label className="grid min-w-0 flex-1 gap-2 text-sm font-semibold">평가 자료<select className={field} value={dataset} disabled={busy || requestId.current !== null} onChange={(event) => changeDataset(event.target.value)}>{datasets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="grid min-w-56 flex-1 gap-2 text-sm font-semibold">기준 실행<select className={field} value={reference} disabled={busy || requestId.current !== null} onChange={(event) => setReference(event.target.value)}>{selected?.baseline && <option value={selected.baseline.id}>{selected.baseline.label}</option>}{selected?.captures.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          {mode === 'replay' && <label className="grid min-w-56 flex-1 gap-2 text-sm font-semibold">후보 실행<select className={field} value={candidate} disabled={busy || requestId.current !== null} onChange={(event) => setCandidate(event.target.value)}>{selected?.captures.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
          <button className={styles.primaryButton} disabled={busy || !dataset || !reference || !candidate || (mode === 'live' && (!approved || !liveEnabled))}>{busy ? '접수 중…' : submitError ? '같은 요청으로 재시도' : mode === 'live' ? '새 응답 생성 및 평가' : '평가 실행'}</button>
          {mode === 'live' && selected && <div className="w-full rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6">
            <p>모델: <strong>{selected.live_config.model}</strong> · 최대 {selected.live_config.max_model_calls}회 · 호출당 출력 최대 {selected.live_config.max_output_tokens.toLocaleString()}토큰 · 자동 재호출 없음</p>
            <p>전송 자료: {selected.fixture}의 {selected.case_ids.join(', ')} 질문과 고정 근거 청크. 시스템 답변 지침을 함께 전송합니다. 평가용 가상 자료이며 실제 회원 대화는 사용하지 않습니다.</p>
            {!liveEnabled && <p role="status" className="font-semibold">새 모델 평가가 비활성화되어 있습니다. 실행기의 API 키와 서버 설정을 준비해야 합니다.</p>}
            <label className="mt-3 flex items-start gap-2"><input type="checkbox" className="mt-1" checked={approved} disabled={!liveEnabled || busy || requestId.current !== null} onChange={(event) => setApproved(event.target.checked)} />위 자료의 OpenAI 전송과 최대 호출 예산을 확인했습니다.</label>
          </div>}
        </form>
        {selected && <p className="text-xs leading-5 text-sample-muted">비교 범위: {selected.case_ids.join(', ')} · {selected.case_ids.length}건. {mode === 'live' ? '현재 모델의 새 응답과 선택한 기준 응답을 비교합니다.' : reference === candidate ? '같은 저장 결과의 재현 검증입니다.' : '두 실행의 위 사례만 비교합니다. 원본의 다른 사례는 평가 범위에 포함하지 않습니다.'}</p>}
        {submitError && <p role="alert" className="text-sm text-red-700">{submitError}</p>}
      </section>
      <section className={styles.card} aria-label="평가 실행 이력">
        <h2 className={styles.cardTitle}>실행 이력{data ? ` · ${data.count}건` : ''}</h2>
        <p className={styles.cardDescription}>목록은 마지막으로 확인한 상태입니다. 실행을 열면 최신 상태를 확인합니다.</p>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !data ? <p role="status">실행 이력을 불러오고 있습니다.</p> : !data.results.length ? <p className="py-8 text-center text-sm text-sample-muted">아직 실행한 평가가 없습니다.</p> : <div className="overflow-x-auto">
          <table className="w-full text-left text-sm"><thead className="border-b border-sample-border text-xs text-sample-muted"><tr>{['평가 자료 / 요청', '상태', '요청자', '요청 시각'].map((label) => <th key={label} className="px-3 py-3 whitespace-nowrap">{label}</th>)}</tr></thead>
            <tbody>{data.results.map((run) => <tr key={run.id} className="border-b border-sample-border last:border-0"><td className="min-w-64 px-3 py-4"><Link className="font-semibold text-brand-primary hover:underline" to={`${listPath}/${run.id}`}>{run.dataset_label}<span className="mt-1 block font-mono text-xs font-normal text-sample-muted">{run.id}</span></Link><span className="text-xs text-sample-muted">{run.execution_mode === 'live' ? '새 모델 응답 평가' : '저장 응답 재평가'}</span></td><td className="px-3 py-4"><Status run={run} />{run.error_message && <p className="mt-2 max-w-56 text-xs text-red-700">{run.error_message}</p>}</td><td className="px-3 py-4">{run.requested_by}</td><td className="px-3 py-4 whitespace-nowrap">{date(run.created_at)}</td></tr>)}</tbody>
          </table></div>}
        {data && <nav aria-label="평가 이력 페이지" className="mt-3 flex items-center justify-end gap-3 text-sm"><button className={styles.secondaryButton} disabled={!data.previous} onClick={() => setSearch({ page: String(page - 1) })}>이전</button><span>{page} / {Math.max(1, Math.ceil(data.count / 25))}</span><button className={styles.secondaryButton} disabled={!data.next} onClick={() => setSearch({ page: String(page + 1) })}>다음</button></nav>}
      </section>
    </div>
  </>
}

function EvaluationDetail({ onExpired, onReviewChanged }: { onExpired: () => void; onReviewChanged: () => void }) {
  const { runId = '' } = useParams()
  const [run, setRun] = useState<EvaluationRun | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const expiry = useRef(onExpired); expiry.current = onExpired
  const terminal = run !== null && ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED'].includes(run.status)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const value = await getEvaluation(runId, controller.signal)
        if (controller.signal.aborted) return
        setRun(value); setError('')
        if (value.prefect_flow_run_id && !['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED'].includes(value.status)) timer = setTimeout(() => void read(), 5_000)
      } catch (reason) {
        if (controller.signal.aborted) return
        if (reason instanceof OpsApiError && (reason.status === 401 || reason.status === 403)) expiry.current()
        else setError(message(reason))
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [runId, refresh])
  const retry = async () => {
    if (!run || busy) return
    setBusy(true)
    try { setRun(await submitEvaluation(run.id, run.dataset_id, run.candidate_capture_id, run.reference_capture_id, run.live_config)); setRefresh((value) => value + 1) }
    catch (reason) {
      if (reason instanceof OpsApiError && (reason.status === 401 || reason.status === 403)) expiry.current()
      else setError(message(reason))
    } finally { setBusy(false) }
  }
  return <>
    <WorkspacePageHeader title="평가 실행 상세" parent={{ to: listPath, label: '실행 이력' }} actions={run && <Status run={run} />} />
    <div className={styles.content}>
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap items-center gap-3"><button className={styles.secondaryButton} onClick={() => setRefresh((value) => value + 1)}>상태 다시 확인</button>{run?.prefect_flow_run_id && !terminal && !error && <p className="text-xs text-sample-muted">5초마다 상태를 확인합니다.</p>}</div>
      {!run ? !error && <p role="status">실행 정보를 불러오고 있습니다.</p> : <>
        {run.error_message && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">{run.error_message}</p>}
        {run.can_retry && <button className={`${styles.primaryButton} self-start`} disabled={busy} onClick={() => void retry()}>{busy ? '접수 확인 중…' : '같은 요청으로 접수 재확인'}</button>}
        <section className={styles.card}><h2 className={styles.cardTitle}>{run.dataset_label}</h2><p className="text-sm leading-6 text-sample-muted">{run.execution_mode === 'live' ? liveNotice : notice}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm">{[
            ['실행 방식', run.execution_mode === 'live' ? '새 모델 응답 생성' : '저장 응답 재평가'], ['요청 ID', run.id],
            ['모델 호출 시도', run.model_api_calls === null ? '아직 확인되지 않음' : `${run.model_api_calls}회`],
            ...(run.live_config ? [['승인 예산', `${run.live_config.model} · 최대 ${run.live_config.max_model_calls}회 · 출력 최대 ${run.live_config.max_output_tokens}토큰/호출`]] : []), ['기준 실행', run.reference_label], ['후보 실행', run.candidate_label], ['요청자', run.requested_by], ['요청 시각', date(run.created_at)],
            ['시작 / 종료', `${date(run.started_at)} / ${date(run.finished_at)}`], ['마지막 상태 확인', date(run.synced_at)], ['평가 결과 ID', run.evaluation_run_id ?? '결과 대기'],
          ].map(([label, value]) => <div key={label} className="contents"><dt className="text-sample-muted">{label}</dt><dd className="break-all">{value}</dd></div>)}</dl>
        </section>
        {run.status === 'COMPLETED' && <section className={styles.card} aria-label="평가 결과"><h2 className={styles.cardTitle}>평가 결과</h2><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[
          ['처리 사례', `${run.summary.observedCaseCount ?? '—'} / ${run.summary.caseCount ?? '—'}`], ['상태 일치율', run.summary.statusAccuracy?.toFixed(2) ?? '미측정'],
          ['인용 재현율', run.summary.referenceCitationRecall?.toFixed(2) ?? '미측정'], ['모델 API 호출', run.model_api_calls === null ? '미확인' : `${run.model_api_calls}회`],
        ].map(([label, value]) => <div className="rounded-xl bg-[#f3f7f5] p-4" key={label}><p className="text-xs text-sample-muted">{label}</p><strong className="mt-3 block text-2xl">{value}</strong></div>)}</div><p className="text-xs leading-5 text-sample-muted">점수 범위는 0–1입니다. AI 작성 참조 자료에 대한 평가이며 의미 충실도는 미측정입니다. 완료 상태는 품질 합격을 뜻하지 않습니다.</p></section>}
        {run.status === 'COMPLETED' && (run.comparison ? <ComparisonResult comparison={run.comparison} /> : <p className="text-sm text-sample-muted">이전 실행에는 비교 상세가 없습니다. 새 평가를 실행하면 기준·후보 차이를 확인할 수 있습니다.</p>)}
        {run.status === 'COMPLETED' && <EvaluationReviewPanel runId={run.id} onExpired={onExpired} onChanged={onReviewChanged} />}
        <section className={styles.card}><h2 className={styles.cardTitle}>상세 기록과 보고서</h2><div className="flex flex-wrap gap-3">
          {run.report_url && <a className={styles.primaryButton} href={run.report_url} target="_blank" rel="noopener noreferrer">Evidently 보고서</a>}
          {run.trace_links.map((trace) => <a key={trace.case_id} className={styles.secondaryButton} href={trace.url} target="_blank" rel="noopener noreferrer">Langfuse {trace.case_id} 추적·점수</a>)}
          {run.langfuse_url && <a className={styles.secondaryButton} href={run.langfuse_url} target="_blank" rel="noopener noreferrer">Langfuse 평가 점수</a>}
          {run.prefect_url && <a className={styles.secondaryButton} href={run.prefect_url} target="_blank" rel="noopener noreferrer">Prefect 실행 로그</a>}
          {!run.report_url && !run.prefect_url && <p className="text-sm text-sample-muted">평가가 접수되면 실행 기록을 확인할 수 있습니다.</p>}
        </div></section>
      </>}
    </div>
  </>
}

const metricLabels = {
  statusAccuracy: '상태 일치율', referenceCitationRecall: '인용 재현율', failureRate: '실패율', missingRate: '누락률',
  meanLatencyMs: '평균 지연 (ms)', meanInputTokens: '평균 입력 토큰', meanOutputTokens: '평균 출력 토큰', semanticFaithfulness: '의미 충실도',
}
const measurement = (value: number | null) => value === null ? '미측정' : value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function ComparisonResult({ comparison }: { comparison: NonNullable<EvaluationRun['comparison']> }) {
  return <section className={styles.card} aria-label="기준·후보 비교">
    <h2 className={styles.cardTitle}>기준·후보 비교</h2>
    <p className={styles.cardDescription}>{comparison.comparison === 'self-replay' ? '같은 저장 결과를 다시 계산한 재현 검증입니다.' : '기준 응답과 후보 응답을 비교합니다.'} 비교 사례: {comparison.case_ids.join(', ')} ({comparison.case_ids.length}건).</p>
    <p className="text-xs leading-5 text-sample-muted">변화량은 후보 − 기준입니다. 비율은 0–1이며 미측정 값은 0으로 계산하지 않습니다. 이 표만으로 전체 모델의 품질 향상이나 변경 원인의 효과를 판단하지 않습니다.</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-sample-border"><tr>{['지표', '기준', '후보', '변화량 (후보 − 기준)'].map((label) => <th className="px-3 py-3 whitespace-nowrap" key={label}>{label}</th>)}</tr></thead><tbody>
      {comparison.metrics.map((metric) => <tr key={metric.key} className="border-b border-sample-border"><th scope="row" className="px-3 py-3 font-medium">{metricLabels[metric.key]}</th><td className="px-3 py-3">{measurement(metric.reference)}</td><td className="px-3 py-3">{measurement(metric.candidate)}</td><td className="px-3 py-3 font-mono">{metric.delta === null ? '비교 불가' : `${metric.delta > 0 ? '+' : ''}${measurement(metric.delta)}`}</td></tr>)}
    </tbody></table></div>
    <div className="grid gap-4 md:grid-cols-2">{([['기준', comparison.reference_execution], ['후보', comparison.candidate_execution]] as const).map(([label, execution]) => <div className="rounded-xl bg-[#f3f7f5] p-4 text-xs leading-6 break-all" key={label}>
      <h3 className="text-sm font-bold">{label} 실행 정보</h3><p>모델: {execution.model}</p><p>원 실행 시각: {date(execution.started_at)}</p><p>원본 사례: {execution.source_case_ids.join(', ')}</p><p>프롬프트: {execution.prompt_sha256}</p><p>실행기: {execution.runner_sha256}</p><p>캡처: {execution.capture_sha256}</p>
    </div>)}</div>
    <details className="text-sm"><summary className="cursor-pointer font-semibold">사례별 상태·인용 비교</summary><div className="overflow-x-auto"><table className="mt-3 w-full text-left text-xs"><thead><tr>{['사례', '기준 결과', '후보 결과', '상태 일치 (기준 → 후보)', '인용 재현 (기준 → 후보)'].map((label) => <th className="px-2 py-2" key={label}>{label}</th>)}</tr></thead><tbody>{comparison.cases.map((item) => <tr key={item.case_id}><th className="px-2 py-2">{item.case_id}</th><td>{item.reference.outcome}</td><td>{item.candidate.outcome}</td><td>{measurement(item.reference.status_match)} → {measurement(item.candidate.status_match)}</td><td>{measurement(item.reference.citation_recall)} → {measurement(item.candidate.citation_recall)}</td></tr>)}</tbody></table></div></details>
  </section>
}
