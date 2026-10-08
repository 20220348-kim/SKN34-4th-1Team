import { useCallback, useEffect, useState } from 'react'

import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import type { PlanUsageUseCase } from '@govbiz/shared/domain/usecases/PlanUsageUseCase'
import { appContainer } from '../../../app/appContainer'

export type PlanUsageLoad = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; usage: PlanUsage }

/**
 * 현재 요금제와 기능별 이용량을 읽습니다. 화면에 들어올 때 한 번, 유료 기능을 실행해 본 뒤에는 [reload]로 다시 읽습니다.
 * 다시 읽는 동안에는 앞서 읽은 값을 그대로 두고(실패 뒤의 다시 시도만 loading), 읽지 못하면 failed로 바꿔 오래된 숫자를 보여 주지 않습니다.
 * 실행할 수 있는지는 서버가 다시 판단하므로 이 값은 미리 알리는 데만 씁니다. `enabled`가 거짓이면 읽지 않습니다.
 */
export function usePlanUsage(
  enabled = true,
  useCase: Pick<PlanUsageUseCase, 'usage'> = appContainer.resolve('planUsageUseCase'),
) {
  const [load, setLoad] = useState<PlanUsageLoad>({ status: 'loading' })
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoad((current) => current.status === 'failed' ? { status: 'loading' } : current)
    useCase.usage(controller.signal)
      .then((usage) => { if (!controller.signal.aborted) setLoad({ status: 'ready', usage }) })
      .catch(() => { if (!controller.signal.aborted) setLoad({ status: 'failed' }) })
    return () => controller.abort()
  }, [enabled, revision, useCase])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  return { load, usage: load.status === 'ready' ? load.usage : null, reload }
}
