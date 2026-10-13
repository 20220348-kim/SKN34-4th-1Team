import { useEffect, useRef, useState } from 'react'
import { getEvaluationLogs, OpsApiError, type EvaluationLogs } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const levelName = (level: number) => ({ 10: 'DEBUG', 20: 'INFO', 30: 'WARNING', 40: 'ERROR', 50: 'CRITICAL' })[level] ?? String(level)

export function EvaluationLogsPanel({ runId, flowId, onExpired }: { runId: string; flowId: string; onExpired: () => void }) {
  const [query, setQuery] = useState<{ offset: number } | null>(null)
  const [data, setData] = useState<EvaluationLogs | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    if (!query) return
    const controller = new AbortController()
    setBusy(true); setData(null); setError('')
    void getEvaluationLogs(runId, flowId, query.offset, controller.signal).then((value) => {
      if (!controller.signal.aborted) setData(value)
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && (reason.status === 401 || reason.status === 403)) expiry.current()
      else setError(reason instanceof Error ? reason.message : '실행 로그를 가져오지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [runId, flowId, query])

  return <section className={styles.card} aria-label="Prefect 실행 로그">
    <h2 className={styles.cardTitle}>Prefect 실행 로그</h2>
    <button type="button" className={`${styles.secondaryButton} self-start`} disabled={busy} onClick={() => setQuery({ offset: 0 })}>
      {query ? '최신 로그 새로고침' : 'Prefect 실행 로그'}
    </button>
    {busy && <p role="status" className="text-sm text-ink-muted">실행 로그를 불러오고 있습니다.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {data && <>
      <p className="text-sm text-ink-muted">최신순으로 최대 100개씩 표시합니다. 새 로그는 새로고침하면 확인할 수 있습니다.</p>
      {data.results.length === 0 ? <p role="status" className="text-sm text-ink-muted">이 페이지에 저장된 실행 로그가 없습니다.</p>
        : <ol aria-label="실행 로그 목록" className="max-h-[32rem] space-y-3 overflow-auto rounded-xl bg-slate-950 p-4 text-sm text-slate-100">
          {data.results.map((log) => <li key={log.id} className="border-b border-slate-700 pb-3 last:border-0">
            <p className={log.level >= 40 ? 'text-red-300' : log.level >= 30 ? 'text-amber-300' : 'text-slate-300'}>
              <time dateTime={log.timestamp}>{new Date(log.timestamp).toLocaleString('ko-KR')}</time> · {levelName(log.level)} · {log.name}
            </p>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{log.message}</pre>
          </li>)}
        </ol>}
      <div className="flex flex-wrap gap-3">
        {data.offset > 0 && <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setQuery({ offset: Math.max(0, data.offset - 100) })}>이전 페이지</button>}
        {data.next_offset !== null && <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setQuery({ offset: data.next_offset! })}>더 오래된 로그</button>}
      </div>
    </>}
  </section>
}
