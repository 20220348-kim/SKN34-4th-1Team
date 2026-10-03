import { useEffect, useRef, useState } from 'react'
import { getLiveReadiness, OpsApiError, type LiveReadiness } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

// The parent keys this panel by dataset/profile, so old selection results cannot survive a change.
export function LiveReadinessPanel({ datasetId, executionProfile, onExpired }: {
  datasetId: string; executionProfile: string; onExpired: () => void
}) {
  const [result, setResult] = useState<LiveReadiness | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  const check = async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setResult(null); setError('')
    try {
      const value = await getLiveReadiness(datasetId, executionProfile, controller.signal)
      if (!controller.signal.aborted) setResult(value)
    } catch (reason) {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) onExpired()
      setError(reason instanceof Error ? reason.message : '점검 결과를 확인할 수 없습니다.')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <section aria-label="실행 설정·예산 점검" className="w-full space-y-3 rounded-xl border border-sample-border bg-white p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">실행 전 설정·예산 확인</h3>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void check()}>{busy ? '점검 중…' : '실행 설정·예산 점검'}</button>
    </div>
    <p>선택한 자료의 호출 계획과 현재 접수 설정·잔여 예산을 조회합니다. 모델 호출·예산 예약·한도 변경은 없습니다.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {result && <>
      <p role="status" className="font-semibold">{result.state === 'blocked' ? '설정·예산에 확인이 필요한 항목이 있습니다.' : '조회 시점의 설정·예산에서 차단 사유가 없습니다.'}</p>
      <p className="text-xs text-sample-muted">조회 시각: {new Date(result.as_of).toLocaleString('ko-KR')} · 모델: {result.model}</p>
      <table className="w-full text-left"><caption className="sr-only">이번 실행의 최대 예약량과 조회 시점 잔여 한도</caption>
        <thead><tr><th scope="col">항목</th><th scope="col">이번 최대 예약량</th><th scope="col">잔여 한도</th></tr></thead>
        <tbody>{([['calls', '모델 호출 수'], ['input_tokens', '입력 토큰'], ['output_tokens', '출력 토큰']] as const).map(([key, label]) => <tr key={key}>
          <th scope="row">{label}</th><td>{result.required[key].toLocaleString()}</td><td>{result.remaining?.[key]?.toLocaleString() ?? '확인 불가·미설정'}</td>
        </tr>)}</tbody>
      </table>
      {result.blockers.length > 0 && <ul className="list-disc space-y-1 pl-5 text-red-700" aria-label="점검 차단 사유">{result.blockers.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>}
      {result.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-amber-800" aria-label="점검 주의 사항">{result.warnings.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>}
      <p className="text-xs text-sample-muted">실제 사용량·금액 견적이 아닌 최대 예약량입니다. 이 결과는 실행 승인이 아니며 다른 실행으로 잔여 한도가 바뀔 수 있습니다. 접수 시 서버가 다시 검증합니다. API 연결·실행기 상태·선택한 비교 기준과 답변 품질은 이 점검에 포함하지 않습니다.</p>
    </>}
  </section>
}
