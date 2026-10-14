import { useEffect, useRef, useState } from 'react'
import { getScheduleRuntime, OpsApiError, type ScheduleRuntime } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles, workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'

const checks = [
  ['evidence', '평가 자료', '등록된 평가 자료와 파일의 일치 여부'],
  ['results_directory', '결과 저장소', 'Ops에서 결과 저장소에 접근할 수 있는지'],
  ['prefect_deployment', 'Prefect 등록', '평가 작업을 관리하는 Prefect에 실행할 작업이 등록되어 있고 일시 중지되지 않았는지'],
] as const

export function ScheduleRuntimeCheck({ onExpired }: { onExpired: () => void }) {
  const [result, setResult] = useState<ScheduleRuntime | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  const check = async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setResult(null); setError('')
    try {
      const value = await getScheduleRuntime(controller.signal)
      if (!controller.signal.aborted) setResult(value)
    } catch (reason) {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) onExpired()
      setError(reason instanceof Error ? reason.message : '연결 설정 점검 결과를 가져오지 못했습니다.')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <section aria-label="정기 실행 연결 설정" className="space-y-3 rounded-xl border border-line bg-white p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">연결 설정 확인</h3>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void check()}>{busy ? '점검 중…' : '연결 설정 점검'}</button>
    </div>
    <p>평가 자료·결과 저장소·Prefect 등록을 조회합니다. 모델 호출, 예산 예약, 정기 계획 등록은 하지 않습니다.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {result && <p role="status" className={result.status === 'FAIL' ? 'font-semibold text-red-700' : 'font-semibold'}>
      {result.status === 'FAIL' ? '연결 설정에 확인이 필요한 항목이 있습니다.' : '조회 시점의 연결 설정 점검을 통과했습니다.'}
    </p>}
    <ul className="space-y-2" aria-label="연결 설정 점검 항목">
      {checks.map(([key, label, description]) => <li key={key} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-surface-muted p-3">
        <div><p className="font-semibold">{label}</p><p className="mt-1 text-xs text-ink-muted">{description}</p></div>
        <span className={workspaceTagClassName(!result ? 'muted' : result.checks[key] === 'PASS' ? 'ok' : 'danger')}>
          {!result ? '미점검' : result.checks[key] === 'PASS' ? '통과' : '확인 필요'}
        </span>
      </li>)}
    </ul>
    {result?.status === 'FAIL' && <p className="text-xs text-ink-muted">확인 필요 항목의 서버 설정·서비스 연결을 운영 담당자가 점검한 뒤 다시 조회하세요.</p>}
    <p className="text-xs text-ink-muted">이 점검은 평가 실행기·정기 접수 처리기(ops-sync)의 실제 가동, 모델 API 키의 유효성, 평가 완료를 확인하지 않습니다. 통과해도 유료 실행 활성화·예산·승인된 비교 기준은 별도로 확인해야 합니다.</p>
  </section>
}
