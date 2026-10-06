import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { getPerformanceDashboard, OpsApiError } from '../../../data/ops/opsApi'
import type { PerformanceDashboard as Dashboard, PerformancePoint, PerformanceSeries } from '../../../data/ops/opsApi'
import { WorkspacePageHeader } from '../../shared/workspace/WorkspacePageHeader'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const metrics = [
  { key: 'status', label: '답변 상태 일치율', color: '#13795b', description: '답변 가능·근거 부족 상태가 참조 조건과 일치한 비율' },
  { key: 'citation', label: '근거 인용 재현율', color: '#2563eb', description: '참조 근거 중 답변이 인용한 근거의 비율' },
  { key: 'retrieval', label: '근거 검색 재현율', color: '#a15315', description: '참조 근거 중 검색 결과에 포함된 근거의 비율' },
] as const
type Metric = typeof metrics[number]['key']
const field = 'min-h-11 w-full rounded-lg border border-line bg-white px-3 text-sm focus-visible:outline-2 focus-visible:outline-brand-primary'
const percent = (value: number | null) => value === null ? '미측정' : `${(value * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`
const date = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const scope = (series: PerformanceSeries) => series.scope === 'source-chunks-retrieval-answer' ? '고정 원문 RAG' : '고정 근거 답변'
const chartDate = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const runPath = (point: PerformancePoint) => `/ops/evaluations/${point.run_id}`

function change(current: PerformancePoint, previous: PerformancePoint | undefined, key: Metric) {
  const now = current.values[key], before = previous?.values[key]
  if (now === null || before == null || !current.coverage[key] || current.coverage[key] !== previous?.coverage[key]) return '비교 가능한 이전 측정 없음'
  const delta = (now - before) * 100
  return delta === 0 ? '이전 측정과 동일' : `이전 대비 ${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%p`
}

export function PerformanceDashboard({ onExpired }: { onExpired: () => void }) {
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const expiry = useRef(onExpired); expiry.current = onExpired
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    getPerformanceDashboard(controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(reason instanceof OpsApiError && reason.status === 404 ? '성능 조회 API를 찾을 수 없습니다. Ops 서버에 최신 변경을 적용한 뒤 다시 확인하세요.' : reason instanceof Error ? reason.message : '대시보드를 불러오지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  const model = params.get('model') || data?.configured_model || ''
  const days = ['30', '90', 'all'].includes(params.get('days') ?? '') ? params.get('days')! : 'all'
  const groups = data?.series.filter((series) => series.model === model) ?? []
  const selected = groups.find((series) => series.id === params.get('series')) ?? groups[0]
  const cutoff = days === 'all' ? -Infinity : Date.parse(data?.as_of ?? '') - Number(days) * 86_400_000
  const points = selected?.points.filter((point) => Date.parse(point.measured_at) >= cutoff) ?? []
  const latest = points.at(-1)
  const models = [...new Set([data?.configured_model ?? '', ...data?.series.map((series) => series.model) ?? [], model])].filter(Boolean)
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params); next.set(key, value)
    if (key === 'model') next.delete('series')
    setParams(next)
  }
  return <>
    <WorkspacePageHeader title="성능 대시보드" actions={<><button className={styles.secondaryButton} disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? '불러오는 중…' : '지표 새로고침'}</button><Link className={styles.secondaryButton} to="/ops/evaluations">평가 이력 보기</Link></>} />
    <div className={styles.content}>
      <p className="text-sm leading-6 text-ink-muted">저장된 실제 모델 실행을 기준으로 최근 성능과 변화를 확인합니다. 실시간 서비스 전체의 품질을 의미하지 않습니다.</p>
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}{data && ' 마지막 조회 결과를 표시하고 있습니다.'}</p>}
      {loading && !data && <p role="status">저장된 평가 지표를 불러오고 있습니다.</p>}
      {data && <>
        <section aria-label="조회 범위" className="rounded-xl border border-line bg-white p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p><span className="text-ink-muted">Ops 평가 설정 모델</span> <strong className="ml-2 text-ink">{data.configured_model}</strong></p><p className="text-xs text-ink-muted">조회 {date(data.as_of)} · 서울 시간</p></div>
          <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_2fr_1fr]">
            <label className="min-w-0 text-sm font-medium">측정 모델<select className={`${field} mt-2`} value={model} onChange={(event) => filter('model', event.target.value)}>{models.map((name) => <option key={name} value={name}>{name}{name === data.configured_model ? ' · 현재 평가 설정' : ''}</option>)}</select></label>
            <label className="min-w-0 text-sm font-medium">평가 자료 · 채점 버전<select className={`${field} mt-2`} value={selected?.id ?? ''} onChange={(event) => filter('series', event.target.value)} disabled={!groups.length}>{!groups.length && <option value="">비교할 실측 없음</option>}{groups.map((series) => <option key={series.id} value={series.id}>{series.dataset_label} · {series.evaluator_version.slice(0, 7)} · {series.points.length}회</option>)}</select></label>
            <label className="text-sm font-medium">측정 기간<select className={`${field} mt-2`} value={days} onChange={(event) => filter('days', event.target.value)}><option value="all">조회 범위 전체</option><option value="30">최근 30일</option><option value="90">최근 90일</option></select></label>
          </div>
        </section>
        {latest && selected ? <>
          <section aria-label="최근 측정 요약" className="rounded-xl bg-[#123d32] p-5 text-white sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-xs font-semibold tracking-wider text-[#c1ded1]">최근 실측 · {scope(selected)}</p><h2 className="mt-2 text-xl font-bold sm:text-2xl">{selected.model}</h2><p className="mt-2 text-sm leading-6 text-[#e0eee8]">{date(latest.measured_at)} 측정 · {selected.case_ids.length}개 사례 · 선택 조건의 실측 {points.length}회{latest.mode === 'recovery' && ' · 원본 응답 후처리 복구'}</p></div><Link className="rounded-lg border border-white/40 px-4 py-3 text-sm font-semibold text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white" to={runPath(latest)}>최근 답변·검토 확인 →</Link></div>
            <p className="mt-4 border-t border-white/20 pt-3 text-xs leading-5 text-[#e0eee8]">자동 지표가 높아도 사실 정확성이나 사람 검토 합격을 보장하지 않습니다. 답변과 근거는 상세 평가에서 확인하세요.</p>
          </section>
          <section aria-label="최근 성능 지표" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {metrics.map((metric) => <article key={metric.key} className="rounded-xl border border-line bg-white p-4 sm:p-5"><h3 className="text-sm font-medium text-ink-muted">{metric.label}</h3><p className="mt-3 text-2xl font-bold tabular-nums sm:text-3xl text-ink">{percent(latest.values[metric.key])}</p><p className="mt-2 text-xs font-medium text-ink">{change(latest, points.at(-2), metric.key)}</p><p className="mt-3 text-xs leading-5 text-ink-muted">{latest.values[metric.key] !== null ? `${latest.samples[metric.key] ?? '미확인'}개 사례 측정 / 전체 ${selected.case_ids.length}개` : metric.key === 'retrieval' && selected.scope === 'fixed-answer-context-only' ? '이 평가에는 검색 단계가 없습니다.' : '저장된 측정값이 없습니다.'}</p></article>)}
            <article className="rounded-xl border border-line bg-white p-4 sm:p-5"><h3 className="text-sm font-medium text-ink-muted">평균 답변 지연</h3><p className="mt-3 text-2xl font-bold tabular-nums sm:text-3xl text-ink">{latest.values.latency === null ? '미측정' : <>{(latest.values.latency / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}<span className="ml-1 text-base font-medium">초</span></>}</p><p className="mt-2 text-xs text-ink">저장된 답변 생성 시간</p><p className="mt-3 text-xs leading-5 text-ink-muted">전체 API 응답 시간과 다릅니다.</p></article>
          </section>
          <TrendChart points={points} />
          <section className={styles.card} aria-label="실측 이력">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className={styles.cardTitle}>실측 이력</h2><span className="text-xs text-ink-muted">같은 자료·사례·채점 버전 · 최근 순</span></div>
            <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><caption className="sr-only">선택한 조건의 실측별 지표와 상세 평가 링크</caption><thead className="border-b border-line text-xs text-ink-muted"><tr>{['측정 시각 (서울)', '상태 일치', '근거 인용', '근거 검색', '프롬프트', '결과'].map((label) => <th key={label} scope="col" className="px-2 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{points.slice().reverse().map((point) => <tr key={point.run_id} className="border-b border-line last:border-0"><th scope="row" className="px-2 py-4 font-normal">{date(point.measured_at)}{point.mode === 'recovery' && <span className="mt-1 block text-xs text-ink-muted">후처리 복구</span>}</th>{metrics.map((metric) => <td key={metric.key} className="px-2 py-4 tabular-nums">{percent(point.values[metric.key])}</td>)}<td className="px-2 py-4 font-mono text-xs">{point.prompt_sha256?.slice(0, 7) ?? '미확인'}</td><td className="px-2 py-4"><Link className="font-medium text-brand-primary underline underline-offset-4" to={runPath(point)} aria-label={`${date(point.measured_at)} 평가 상세`}>상세 보기</Link></td></tr>)}</tbody></table></div>
            <p className="mt-4 text-xs text-ink-muted">최근 답변당 평균 토큰: 입력 {latest.values.input_tokens?.toLocaleString('ko-KR', { maximumFractionDigits: 0 }) ?? '미측정'} · 출력 {latest.values.output_tokens?.toLocaleString('ko-KR', { maximumFractionDigits: 0 }) ?? '미측정'}. 비용·예산은 <Link to="/ops/budget" className="text-brand-primary underline">예산 관리</Link>에서 확인하세요.</p>
          </section>
        </> : <section className={`${styles.card} py-10 text-center`} aria-label="실측 없음"><h2 className={styles.cardTitle}>이 조건의 실측 결과가 없습니다</h2><p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-ink-muted">측정 모델·자료·기간을 바꾸거나 평가 이력을 확인하세요. 저장 응답 재평가는 새 모델 측정으로 집계하지 않습니다.</p><Link to="/ops/evaluations" className={`${styles.secondaryButton} mt-5`}>평가 이력 확인</Link></section>}
        <section className="rounded-xl border border-line bg-white p-5" aria-label="집계 기준">
          <h2 className="font-semibold text-ink">집계 범위와 실행 상태</h2>
          <p className="mt-2 text-sm leading-6 text-ink-muted">최근 요청 {data.window.loaded}건 / 전체 {data.window.total}건 기준입니다. 아래 실행 상태는 모델·자료·기간 필터 적용 전의 조회 범위입니다.{data.window.truncated && ` 최근 ${data.window.limit}건까지만 조회하므로 전체 기간 통계가 아닙니다.`}</p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{([['완료', data.states.completed], ['실패·결과 오류', data.states.failed], ['진행 중', data.states.active], ['취소', data.states.cancelled]] as const).map(([label, count]) => <div key={label} className="rounded-lg bg-surface-muted p-3"><dt className="text-ink-muted">{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{count}<span className="ml-1 text-xs font-normal">건</span></dd></div>)}</dl>
          <details className="mt-4 text-sm"><summary className="cursor-pointer py-2 font-medium text-ink focus-visible:outline-2 focus-visible:outline-brand-primary">통계에 포함하는 기준</summary><div className="mt-2 space-y-2 text-xs leading-6 text-ink-muted"><p>새 모델 실행의 완료 결과와 그 실행의 후처리 복구 결과를 사용합니다. 동일 응답은 조건별로 한 번만 집계하며 복구는 원본 실행 시각을 사용합니다.</p><p>실측 제외: 저장 응답 재평가 {data.excluded.replay}건 · 미완료 {data.excluded.incomplete}건 · 실측 근거 확인 불가 {data.excluded.unverifiable}건 · 동일 응답 중복 {data.excluded.duplicate}건.</p><p>자료·사례·모델·채점 버전·검색 K가 같을 때만 추이를 묶습니다. %p 차이는 측정 사례도 같은 이전 결과에 한해 표시합니다. 미측정 값은 0으로 환산하지 않습니다.</p>{selected && <p className="break-all">자료 해시: {selected.fixture_sha256}<br />채점 버전: {selected.evaluator_version}</p>}</div></details>
        </section>
      </>}
    </div>
  </>
}

function TrendChart({ points }: { points: PerformancePoint[] }) {
  const [key, setKey] = useState<Metric>('status')
  const metric = metrics.find((item) => item.key === key)!
  const measured = points.filter((point) => point.values[key] !== null)
  const x = (index: number) => points.length === 1 ? 330 : 54 + (index / (points.length - 1)) * 566
  const y = (value: number) => 170 - value * 140
  return <section className={styles.card} aria-label="성능 변화 추이">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className={styles.cardTitle}>성능 변화 추이</h2><p className={styles.cardDescription}>{metric.description}. 아래 실측 이력에서 개별 결과를 확인할 수 있습니다.</p></div><div role="group" aria-label="추이 지표" className="flex flex-wrap gap-1">{metrics.map((item) => <button key={item.key} aria-pressed={key === item.key} onClick={() => setKey(item.key)} className={`min-h-10 rounded-lg px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-brand-primary ${key === item.key ? 'bg-brand-soft text-brand-primary' : 'bg-surface-muted text-ink-muted hover:text-ink'}`}>{item.label}</button>)}</div></div>
    {!measured.length ? <p className="py-10 text-center text-sm text-ink-muted">이 지표는 측정되지 않았습니다.</p> : <>
      <svg viewBox="0 0 650 215" className="mt-4 w-full" style={{ maxHeight: 280 }} role="img" aria-label={`${metric.label} 추이, ${points.length}회 중 ${measured.length}회 측정. 수치는 아래 실측 이력 표에서 확인할 수 있습니다.`}>
        {[0, .5, 1].map((value) => <g key={value}><line x1="54" x2="620" y1={y(value)} y2={y(value)} stroke="#dce5e0" strokeDasharray={value === 0 ? undefined : '4 4'} /><text x="43" y={y(value) + 4} textAnchor="end" className="text-[22px] sm:text-[11px]" fill="#5c6b63">{value * 100}%</text></g>)}
        {points.map((point, index) => {
          const value = point.values[key], previous = points[index - 1]?.values[key]
          if (value === null) return null
          const compatible = point.coverage[key] !== null && point.coverage[key] === points[index - 1]?.coverage[key]
          return <g key={point.run_id}>{index > 0 && previous != null && compatible && <line x1={x(index - 1)} y1={y(previous)} x2={x(index)} y2={y(value)} stroke={metric.color} strokeWidth="2.5" />}<circle cx={x(index)} cy={y(value)} r="4.5" fill={metric.color} stroke="white" strokeWidth="2"><title>{date(point.measured_at)} · {percent(value)}</title></circle>{points.length <= 8 && <text x={x(index)} y={y(value) - 11} textAnchor="middle" className="text-[22px] sm:text-[11px]" fill={metric.color}>{percent(value)}</text>}</g>
        })}
        <text x={points.length === 1 ? 330 : 54} y="201" textAnchor={points.length === 1 ? 'middle' : 'start'} className="text-[22px] sm:text-[11px]" fill="#5c6b63">{chartDate(points[0].measured_at)}</text>{points.length > 1 && <text x="620" y="201" textAnchor="end" className="text-[22px] sm:text-[11px]" fill="#5c6b63">{chartDate(points.at(-1)!.measured_at)}</text>}
      </svg>
      <p className="text-xs leading-5 text-ink-muted">{measured.length < 2 ? '측정 1회만 있어 변화 추이를 판단할 수 없습니다.' : '가로축은 실행 순서이며 시간 간격은 동일하지 않습니다. 측정 사례가 달라지거나 값이 없는 구간은 연결하지 않습니다.'}</p>
    </>}
  </section>
}
