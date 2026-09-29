import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { getBudgetReservations, getRunBudget, OpsApiError, type BudgetBreakdown, type BudgetPage, type RunBudget } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const date = (value: string) => new Date(value).toLocaleString('ko-KR')
const count = (value: number) => value.toLocaleString('ko-KR')
const message = (error: unknown) => error instanceof Error ? error.message : '예산 장부를 불러오지 못했습니다.'

function Breakdown({ value }: { value: BudgetBreakdown }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm">
    <caption className="sr-only">예산 할당량 구성</caption>
    <thead className="border-b border-sample-border text-xs text-sample-muted"><tr><th className="py-3">구분</th><th>호출 수</th><th>출력 토큰</th></tr></thead>
    <tbody>{[
      ['확정 사용량', count(value.settled_calls), count(value.confirmed_output_tokens)],
      ['승인 후 사용량 미확인', count(value.unknown_calls), count(value.unknown_output_tokens)],
      ['아직 승인하지 않은 예약', count(value.unapproved_calls), count(value.unapproved_output_tokens)],
      ['종료 전 반환 대기', '—', count(value.pending_release_output_tokens)],
      ['현재 할당량 합계', count(value.allocated_calls), count(value.allocated_output_tokens)],
    ].map(([label, calls, tokens]) => <tr key={label} className="border-b border-sample-border last:border-0"><th scope="row" className="py-3 font-medium">{label}</th><td>{calls}</td><td>{tokens}</td></tr>)}</tbody>
  </table><p className="mt-3 text-xs text-sample-muted">확정 입력: {count(value.confirmed_input_tokens)}토큰 · 입력 토큰은 현재 한도 대상에 포함되지 않습니다.</p></div>
}

export function BudgetOverview({ onExpired, refreshKey }: { onExpired: () => void; refreshKey: number }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<BudgetPage | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setData(null); setError('')
    const read = async () => {
      let keepPolling = true
      try {
        const result = await getBudgetReservations(page, controller.signal)
        if (!controller.signal.aborted) { setData(result); setError('') }
      } catch (reason) {
        if (controller.signal.aborted) return
        if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) {
          keepPolling = false; setData(null); expiry.current()
        } else setError(message(reason))
      } finally {
        if (!controller.signal.aborted && keepPolling) timer = setTimeout(() => void read(), 15_000)
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [page, refresh, refreshKey])
  const summary = data?.summary
  return <section className={styles.card} aria-label="누적 평가 예산">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className={styles.cardTitle}>누적 평가 예산</h2><button className={styles.secondaryButton} onClick={() => setRefresh((value) => value + 1)}>예산 새로고침</button></div>
    <p className={styles.cardDescription}>모든 평가 자료가 공유하는 호출·출력 토큰 한도입니다. 금액 한도가 아니며, 사용량 미확인 호출은 최대 출력 예약을 유지합니다.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error} 표시된 값이 있으면 마지막 조회 기록입니다.</p>}
    {!data && !error && <p role="status">예산 장부를 불러오고 있습니다.</p>}
    {data && summary && <>
      <p className="text-xs text-sample-muted">조회 시각: {date(data.as_of)} · 15초마다 갱신 · 총계는 전체 예약 기준입니다.</p>
      {summary.state === 'unconfigured' && <p role="status">누적 한도가 설정되지 않았습니다. 잔여 예산을 계산할 수 없습니다.</p>}
      {summary.state === 'inconsistent' && <p role="alert" className="text-sm text-red-700">저장된 할당량과 상세 장부가 일치하지 않습니다. 잔여 한도를 확정할 수 없어 표시하지 않습니다.</p>}
      {summary.legacy_live_run_count > 0 && <p className="text-sm text-amber-800">예약 기록이 없는 과거 모델 실행 {count(summary.legacy_live_run_count)}건이 있습니다. 해당 실행의 사용량은 이 장부에서 확인할 수 없습니다.</p>}
      {summary.limits && <dl className="grid gap-3 text-sm sm:grid-cols-3">{[
        ['전체 한도', summary.limits], ['저장된 할당량', summary.allocated], ['잔여 한도', summary.state === 'consistent' ? summary.remaining : null],
      ].map(([label, amount]) => {
        const value = amount as typeof summary.limits
        return <div className="rounded-xl bg-[#f3f7f5] p-4" key={String(label)}><dt className="text-sample-muted">{String(label)}</dt><dd className="mt-2 font-semibold">{value ? `${count(value.calls)}회 · ${count(value.output_tokens)}토큰` : '확인 불가'}</dd></div>
      })}</dl>}
      {summary.breakdown && <Breakdown value={summary.breakdown} />}
      <p className="text-xs leading-5 text-sample-muted">응답을 정산해도 실행의 예약을 닫기 전까지 출력 차액은 반환 대기로 남습니다. 승인 기록만으로 모델 전송 완료나 실제 비용을 확정할 수 없습니다.</p>
      <details><summary className="cursor-pointer text-sm font-semibold">실행별 예약 · {count(data.count)}건</summary>
        {!data.results.length ? <p className="py-3 text-sm">예약 기록이 없습니다.</p> : <div className="overflow-x-auto"><table className="mt-3 w-full text-left text-sm">
          <thead><tr><th>실행</th><th>예약 상태</th><th>할당량</th><th>미확인 호출</th></tr></thead>
          <tbody>{data.results.map((row) => <tr key={row.run_id} className="border-t border-sample-border"><td className="py-3 pr-3"><Link className="text-brand-primary underline" to={`/ops/evaluations/${row.run_id}`}>{row.dataset_id} · {row.run_id.slice(0, 8)}</Link></td><td>{row.closed_at ? '닫힘' : '열림'}</td><td>{count(row.breakdown.allocated_calls)}회 · {count(row.breakdown.allocated_output_tokens)}토큰</td><td>{count(row.breakdown.unknown_calls)}회</td></tr>)}</tbody>
        </table></div>}
      </details>
      <details><summary className="cursor-pointer text-sm font-semibold">한도 변경 이력 · 최근 {summary.recent_changes.length} / 전체 {summary.change_count}건</summary>
        <p className="py-2 text-xs text-sample-muted">변경자는 CLI 운영자가 입력한 값입니다. Core 로그인으로 인증한 신원은 아닙니다. 기존 한도의 과거 변경 기록은 소급 생성하지 않습니다.</p>
        {!summary.recent_changes.length ? <p className="text-sm">기록된 한도 변경 이력이 없습니다.</p> : <ol className="space-y-3 text-sm">{summary.recent_changes.map((change) => <li key={change.request_id} className="border-t border-sample-border pt-3">
          <p>{date(change.created_at)} · {change.actor} · {change.source}</p>
          <p>{change.previous_limits ? `${count(change.previous_limits.calls)}회 / ${count(change.previous_limits.output_tokens)}토큰` : '미설정'} → {count(change.limits.calls)}회 / {count(change.limits.output_tokens)}토큰</p>
          <p className="break-words">사유: {change.reason}</p><p className="break-all text-xs text-sample-muted">요청 ID: {change.request_id}</p>
        </li>)}</ol>}
      </details>
    </>}
    {(data && data.count > 25 || page > 1) && <nav aria-label="예산 예약 페이지" className="flex items-center justify-end gap-3 text-sm"><button className={styles.secondaryButton} disabled={page === 1} onClick={() => setPage((value) => value - 1)}>예약 이전</button><span>{page}페이지</span><button className={styles.secondaryButton} disabled={!data?.next} onClick={() => setPage((value) => value + 1)}>예약 다음</button></nav>}
  </section>
}

export function RunBudgetPanel({ runId, onExpired, refreshKey }: { runId: string; onExpired: () => void; refreshKey: number }) {
  const [data, setData] = useState<RunBudget | null>(null)
  const [error, setError] = useState('')
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setData(null); setError('')
    const read = async () => {
      let keepPolling = true
      try {
        const result = await getRunBudget(runId, controller.signal)
        if (!controller.signal.aborted) { setData(result); setError('') }
      } catch (reason) {
        if (controller.signal.aborted) return
        if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) {
          keepPolling = false; setData(null); expiry.current()
        } else setError(message(reason))
      } finally {
        if (!controller.signal.aborted && keepPolling) timer = setTimeout(() => void read(), 15_000)
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [runId, refreshKey])
  return <section className={styles.card} aria-label="실행 예산 장부">
    <h2 className={styles.cardTitle}>실행 예산 장부</h2>
    {error && <p role="alert" className="text-sm text-red-700">{error} 표시된 값이 있으면 마지막 조회 기록입니다.</p>}
    {!data && !error && <p role="status">실행 예약을 불러오고 있습니다.</p>}
    {data && <>
      <p className="text-xs text-sample-muted">조회 시각: {date(data.as_of)}</p>
      {data.state === 'missing' && <p className="text-sm text-amber-800">이 모델 실행에는 예약 기록이 없습니다. 사용량을 0으로 판단할 수 없습니다.</p>}
      {data.state === 'not_applicable' && <p className="text-sm">새 모델 호출을 예약하는 실행이 아닙니다. 원본 실행의 비용은 원본 장부에서 확인하세요.</p>}
      {data.reservation && <>
        <p className="text-sm">예약 상태: {data.reservation.closed_at ? `닫힘 · ${date(data.reservation.closed_at)}` : '열림'} · 실행의 완료·취소 상태와 별도로 관리합니다.</p>
        <Breakdown value={data.reservation.breakdown} />
        {data.reservation.breakdown.unknown_calls > 0 && <p className="text-sm text-amber-800">미확인 호출은 전송·사용량을 확정하지 못한 상태입니다. 예약이 닫혀도 해당 호출의 최대 출력 몫은 유지됩니다.</p>}
        {data.cleanup && <section aria-label="종료 예약 정리 이력" className="space-y-2 rounded-xl bg-[#f3f7f5] p-4 text-sm">
          <h3 className="font-semibold">종료 예약 정리 이력</h3>
          <p>{date(data.cleanup.created_at)} · {data.cleanup.actor} · CLI</p>
          <p>사유: {data.cleanup.reason}</p>
          <p>반환: {count(data.cleanup.before.reservation_calls - data.cleanup.after.reservation_calls)}회 · {count(data.cleanup.before.reservation_output_tokens - data.cleanup.after.reservation_output_tokens)}출력 토큰</p>
          <p>유지된 미확인 몫: {count(data.cleanup.after.unknown_calls)}회 · {count(data.cleanup.after.unknown_output_tokens)}출력 토큰</p>
          <p>종료 근거: Prefect {data.cleanup.evidence.state_type} · 확인 {date(data.cleanup.evidence.observed_at)}</p>
          <p className="break-all text-xs text-sample-muted">정리 요청: {data.cleanup.request_id} · 종료 상태 ID: {data.cleanup.evidence.state_id}</p>
          <p className="text-xs text-sample-muted">변경자는 CLI 운영자가 입력한 값입니다. 실제 결제 환불이나 미확인 사용량 보정이 아니며 새 모델 실행을 시작하지 않습니다.</p>
        </section>}
        <details><summary className="cursor-pointer text-sm font-semibold">호출별 승인·정산 · {data.calls.length}건</summary>
          <ul className="mt-3 space-y-2 text-sm">{data.calls.map((call) => <li key={call.sequence}>
            호출 {call.sequence + 1} · 승인 {date(call.authorized_at)} · {call.settled_at ? `정산 ${date(call.settled_at)} · 입력 ${count(call.input_tokens!)} / 출력 ${count(call.output_tokens!)}토큰` : '사용량 미확인'}
          </li>)}</ul>
        </details>
      </>}
    </>}
  </section>
}
