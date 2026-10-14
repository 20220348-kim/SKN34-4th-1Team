import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { OpsApiError } from '../../../data/ops/opsApi'
import { getTrace, listTraces, type TraceDetail, type TracePage, type TraceSummary } from '../../../data/ops/traceApi'
import { WorkspacePageHeader } from '../../shared/workspace/WorkspacePageHeader'
import { workspacePageStyles as styles, workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'

const path = '/ops/traces'
const names = [
  ['support-program-search', '공고 검색'], ['assistant-agent', 'AI 도우미'], ['support-program-evidence', '공고 근거 답변'],
] as const
const field = 'min-h-11 w-full rounded-xl border border-line bg-white px-3 text-sm focus:outline-2 focus:outline-brand-primary'
const date = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR') : '기록 없음'
const stageNames: Record<string, string> = {
  'search.total': '공고 검색', 'search.ranking.request': '공고 검색 순위 요청', 'search.ranking.model': '공고 검색 모델 호출',
  'search.semantic.request': '공고 의미 검색 요청',
  'assistant.total': 'AI 도우미', 'assistant.agent': 'AI 도우미 에이전트', 'assistant.model': 'AI 도우미 모델 호출',
  'evidence.total': '공고 근거 답변', 'evidence.answer': '공고 근거 답변', 'evidence.model': '공고 근거 답변 모델 호출',
  'evidence.index': '공고 문서 색인', 'evidence.search': '공고 근거 검색', 'evidence.embedding.request': '공고 문서 임베딩 호출',
}
const nameLabel = (value: string) => stageNames[value] ?? names.find(([name]) => name === value)?.[1] ?? (value || '이름 없는 실행')
const isModelCall = (item: TraceSummary) => ['GENERATION', 'EMBEDDING'].includes(item.type.toUpperCase())
const environmentLabel = (value: string | null) => {
  const environment = value?.trim()
  return environment === 'production' ? '운영 (production)' : environment === 'development' ? '개발 (development)' : environment || '기록 없음'
}
const message = (error: unknown) => error instanceof Error ? error.message : '실행 추적을 불러오지 못했습니다.'
const listKeys = ['name', 'from_time', 'to_time', 'cursor'] as const
function listQuery(search: URLSearchParams) {
  const query = new URLSearchParams()
  for (const key of listKeys) { const value = search.get(key); if (value) query.set(key, value) }
  return query
}
function ErrorNotice({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div className="rounded-xl border border-red-200 bg-red-50 p-4" role="alert"><p>{error}</p><button className={`${styles.secondaryButton} mt-3`} onClick={onRetry}>다시 조회</button></div>
}
function Level({ value }: { value: string }) {
  return <span className={workspaceTagClassName(value === 'ERROR' ? 'danger' : value === 'WARNING' ? 'warn' : 'muted')}>{value === 'ERROR' ? '오류' : value === 'WARNING' ? '주의' : value || '미기록'}</span>
}
function Metrics({ item }: { item: TraceSummary }) {
  const missingModelMetric = isModelCall(item) ? '기록 없음' : '모델 호출 단계에서 확인'
  return <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
    <div><dt className="text-ink-muted">모델</dt><dd className="mt-1 break-all">{item.model?.trim() || missingModelMetric}</dd></div>
    <div><dt className="text-ink-muted">소요 시간</dt><dd className="mt-1">{item.latency_seconds === null ? '기록 없음' : `${item.latency_seconds.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}초`}</dd></div>
    <div><dt className="text-ink-muted">기록된 비용 (USD)</dt><dd className="mt-1">{item.total_cost === null ? missingModelMetric : `$${item.total_cost.toLocaleString('en-US', { maximumFractionDigits: 8 })}`}</dd></div>
    <div><dt className="text-ink-muted">환경</dt><dd className="mt-1 break-all">{environmentLabel(item.environment)}</dd></div>
  </dl>
}

export function TraceListPage({ onExpired }: { onExpired: () => void }) {
  const [search, setSearch] = useSearchParams()
  const query = listQuery(search).toString()
  const [data, setData] = useState<TracePage | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [name, setName] = useState(search.get('name') ?? '')
  const [days, setDays] = useState('7')
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const params = new URLSearchParams(query)
    setName(params.get('name') ?? '')
    const span = (Date.parse(params.get('to_time') ?? '') - Date.parse(params.get('from_time') ?? '')) / 86_400_000
    setDays([1, 7, 30].includes(span) ? String(span) : '7')
  }, [query])
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setError('')
    listTraces(Object.fromEntries(new URLSearchParams(query)), controller.signal).then((value) => {
      if (!controller.signal.aborted) setData(value)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(message(reason))
    })
    return () => controller.abort()
  }, [query, reload])
  const currentQuery = listQuery(search)
  if (data) { currentQuery.set('from_time', data.from_time); currentQuery.set('to_time', data.to_time) }
  const changePage = (cursor: string | null) => {
    if (cursor) currentQuery.set('cursor', cursor); else currentQuery.delete('cursor')
    setSearch(currentQuery)
  }
  return <>
    <WorkspacePageHeader title="AI 실행 추적" actions={<button className={styles.secondaryButton} onClick={() => setReload((value) => value + 1)}>다시 조회</button>} />
    <div className={styles.content}>
      <p className="text-sm text-ink-muted">공고 검색·도우미·근거 답변의 실행 단계와 입력·출력·오류를 확인합니다. GovBiz 관리자 로그인으로 조회하며 새 AI 호출은 발생하지 않습니다. 선택 업무의 서비스별 시작 단계를 최신순으로 조회하며 같은 추적이 여러 행에 나타날 수 있습니다.</p>
      <form className={`${styles.card} sm:flex-row sm:items-end`} aria-label="실행 추적 필터" onSubmit={(event) => {
        event.preventDefault()
        const end = new Date()
        const next = new URLSearchParams({ from_time: new Date(end.getTime() - Number(days) * 86_400_000).toISOString(), to_time: end.toISOString() })
        if (name) next.set('name', name)
        setSearch(next)
      }}>
        <label className="flex flex-1 flex-col gap-2 text-sm">실행 이름<select className={field} value={name} onChange={(event) => setName(event.target.value)}>
          <option value="">전체 실행</option>{names.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          {name && !names.some(([value]) => value === name) && <option value={name}>{name}</option>}
        </select></label>
        <label className="flex flex-1 flex-col gap-2 text-sm">조회 기간<select className={field} value={days} onChange={(event) => setDays(event.target.value)}><option value="1">최근 24시간</option><option value="7">최근 7일</option><option value="30">최근 30일</option></select></label>
        <button className={styles.primaryButton} type="submit">조회</button>
      </form>
      {error ? <ErrorNotice error={error} onRetry={() => setReload((value) => value + 1)} /> : !data ? <p role="status">실행 추적을 불러오고 있습니다.</p> : <>
        <p className="text-xs text-ink-muted">조회 범위: {date(data.from_time)} ~ {date(data.to_time)} · 이 페이지 {data.results.length}건 · 최신순 고정 · 페이지 이동 시 조회 범위를 유지합니다.</p>
        <section aria-label="AI 실행 목록" className="flex min-w-0 flex-col gap-3">
          {!data.results.length && <div className={styles.card}><h2 className={styles.cardTitle}>이 기간에 기록된 실행이 없습니다.</h2><p className="text-sm text-ink-muted">기간이나 실행 이름을 바꿔 조회하세요. 최근 실행은 기록 반영까지 잠시 걸릴 수 있습니다.</p></div>}
          {data.results.map((item) => <article key={item.id} className={styles.card}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className={styles.cardTitle}><Link className="text-brand-primary underline underline-offset-4" to={`${path}/${encodeURIComponent(item.trace_id)}?${currentQuery}`}>{nameLabel(item.name)} · {item.id.slice(0, 8)}</Link></h2><Level value={item.level} /></div>
            <p className="text-xs text-ink-muted">{date(item.started_at)} · {item.type}{item.name && ` · ${item.name}`}</p>
            <Metrics item={item} />
            {!isModelCall(item) && <Link className={styles.quietLink} to={`${path}/${encodeURIComponent(item.trace_id)}?${currentQuery}`}>모델 호출 단계 확인 →</Link>}
            {item.status_message && <p className="rounded-lg bg-surface-muted p-3 text-sm whitespace-pre-wrap break-words">실행 메시지: {item.status_message}</p>}
          </article>)}
        </section>
        <nav aria-label="실행 추적 페이지" className={styles.pagination}>
          <button className={styles.secondaryButton} disabled={!search.get('cursor')} onClick={() => changePage(null)}>첫 페이지</button>
          <button className={styles.secondaryButton} disabled={!data.next_cursor} onClick={() => changePage(data.next_cursor)}>다음 페이지</button>
        </nav>
      </>}
    </div>
  </>
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const text = value === null || value === undefined ? '기록 없음' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return <div className="min-w-0"><h3 className="mb-2 text-sm font-bold">{label}</h3><pre className="max-h-96 overflow-auto rounded-xl bg-surface-muted p-3 text-xs whitespace-pre-wrap break-words">{text || '(빈 값)'}</pre></div>
}

export function TraceDetailPage({ onExpired }: { onExpired: () => void }) {
  const { traceId = '' } = useParams()
  const [search, setSearch] = useSearchParams()
  const cursor = search.get('detail_cursor') ?? undefined
  const [data, setData] = useState<TraceDetail | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setError('')
    getTrace(traceId, cursor, controller.signal).then((value) => {
      if (!controller.signal.aborted) setData(value)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(message(reason))
    })
    return () => controller.abort()
  }, [traceId, cursor, reload])
  const query = listQuery(search).toString()
  const back = query ? `${path}?${query}` : path
  const observations = new Map(data?.observations.map((item) => [item.id, item]))
  const depth = (id: string) => {
    const visited = new Set([id]); let parent = observations.get(id)?.parent_observation_id; let level = 0
    while (parent && observations.has(parent) && !visited.has(parent) && level < 4) {
      visited.add(parent); level += 1; parent = observations.get(parent)?.parent_observation_id
    }
    return level
  }
  const changePage = (next: string | null) => {
    const query = new URLSearchParams(search)
    if (next) query.set('detail_cursor', next); else query.delete('detail_cursor')
    setSearch(query)
  }
  return <>
    <WorkspacePageHeader title="실행 추적 상세" parent={{ to: back, label: 'AI 실행 추적' }} actions={<button className={styles.secondaryButton} onClick={() => setReload((value) => value + 1)}>다시 조회</button>} />
    <div className={styles.content}>
      <Link to={back} className={styles.quietLink}>← 조회하던 실행 목록으로</Link>
      <p className="text-xs break-all text-ink-muted">추적 ID: {traceId}</p>
      {error ? <ErrorNotice error={error} onRetry={() => setReload((value) => value + 1)} /> : !data ? <p role="status">실행 단계를 불러오고 있습니다.</p> : <>
        <p className="text-sm text-ink-muted">이 페이지 {data.observations.length}개 단계입니다. 모델 호출 단계(GENERATION·EMBEDDING)는 펼쳐 표시하며 모델·기록된 비용·토큰 사용량을 확인할 수 있습니다. 단계별 비용은 중첩될 수 있으므로 합산하지 않습니다.</p>
        <section aria-label="실행 단계" className="flex min-w-0 flex-col gap-3">
          {!data.observations.length && <p>이 페이지에 기록된 단계가 없습니다.</p>}
          {data.observations.map((item, index) => <details key={`${cursor ?? 'first'}:${item.id}`} open={index === 0 || isModelCall(item)} className={styles.card} style={{ marginLeft: `${depth(item.id) * 12}px` }}>
            <summary className="cursor-pointer text-sm font-bold"><span>{nameLabel(item.name)}</span> {isModelCall(item) && <span className={workspaceTagClassName('muted')}>모델 호출 단계</span>} <span className="ml-2 text-xs font-normal text-ink-muted">{nameLabel(item.name) !== item.name && item.name && `${item.name} · `}{item.type} · {date(item.started_at)}</span> <Level value={item.level} /></summary>
            <div className="mt-4 flex min-w-0 flex-col gap-4">
              <p className="text-xs break-all text-ink-muted">단계 ID: {item.id}{item.parent_observation_id && ` · 상위 단계: ${nameLabel(observations.get(item.parent_observation_id)?.name ?? '')} (${item.parent_observation_id})`}</p>
              <p className="text-xs text-ink-muted">시작: {date(item.started_at)} · 종료: {date(item.ended_at)}</p>
              <Metrics item={item} />
              <Payload label="토큰 사용량" value={item.usage_details} />
              {item.status_message && <Payload label="실행 메시지" value={item.status_message} />}
              <div className="grid min-w-0 gap-4 xl:grid-cols-2"><Payload label="입력" value={item.input} /><Payload label="출력" value={item.output} /></div>
              <Payload label="추가 기록" value={item.metadata} />
            </div>
          </details>)}
        </section>
        <nav aria-label="실행 단계 페이지" className={styles.pagination}><button className={styles.secondaryButton} disabled={!cursor} onClick={() => changePage(null)}>첫 단계 페이지</button><button className={styles.secondaryButton} disabled={!data.next_cursor} onClick={() => changePage(data.next_cursor)}>다음 단계</button></nav>
      </>}
    </div>
  </>
}
