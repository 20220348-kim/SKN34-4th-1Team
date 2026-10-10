import { useState } from 'react'

import type { PlanCode, PlanUsage, TrialPlanCode } from '@govbiz/shared/domain/entities/PlanUsage'
import { planTrialErrorMessage } from '@govbiz/shared/domain/errors/PlanTrialError'
import type { PlanTrialUseCase } from '@govbiz/shared/domain/usecases/PlanTrialUseCase'
import { appContainer } from '../../../../app/appContainer'
import { usePlanUsage, type PlanUsageLoad } from '../../../shared/plan-usage/usePlanUsage'

/**
 * 요금제 카드 아래 버튼입니다. 로그인 전(search·login), 읽는 중(loading), 지금 요금제(current), 시작할 수 있는 체험(trial),
 * 지금보다 낮은 요금제(included), 이미 체험한 요금제(trialUsed), 운영자 배정 중이라 체험할 수 없는 요금제(unavailable)입니다.
 */
export type PricingPlanAction = 'search' | 'login' | 'loading' | 'current' | 'trial' | 'included' | 'trialUsed' | 'unavailable'

const planRank: Record<PlanCode, number> = { FREE: 0, PLUS: 1, PREMIUM: 2 }

/** [code] 카드에 둘 버튼입니다. [load]가 null이면 로그인 전 공개 화면입니다. 실제로 시작할 수 있는지는 Core가 다시 판단합니다. */
export function pricingPlanAction(code: PlanCode, load: PlanUsageLoad | null): PricingPlanAction {
  if (load === null) return code === 'FREE' ? 'search' : 'login'
  if (load.status !== 'ready') return code === 'FREE' ? 'search' : 'loading'
  const { plan, planSource, trialsAvailable = [] } = load.usage
  if (code === plan) return 'current'
  if (code !== 'FREE' && trialsAvailable.includes(code)) return 'trial'
  if (planRank[code] < planRank[plan ?? 'FREE']) return 'included'
  if (planSource === 'OPERATOR') return 'unavailable'
  return 'trialUsed'
}

type TrialStart = { status: 'idle' } | { status: 'starting'; plan: TrialPlanCode } | { status: 'failed'; plan: TrialPlanCode; message: string }

/**
 * 요금제 화면의 지금 요금제와 출시 전 무료 체험 시작입니다. 로그인한 작업 화면에서만 이용량을 읽습니다.
 * [14일 무료 체험 시작]을 누르면 확인 다이얼로그에서 한 번 더 확인받고, 시작하면 Core가 돌려준 요금제로 카드를 바로 바꿉니다.
 */
export function usePricingPlansViewModel(
  signedIn: boolean,
  useCase: Pick<PlanTrialUseCase, 'start'> = appContainer.resolve('planTrialUseCase'),
) {
  const planUsage = usePlanUsage(signedIn)
  const [started, setStarted] = useState<{ plan: TrialPlanCode; usage: PlanUsage } | null>(null)
  const [confirming, setConfirming] = useState<TrialPlanCode | null>(null)
  const [trial, setTrial] = useState<TrialStart>({ status: 'idle' })
  const load: PlanUsageLoad | null = !signedIn ? null : started ? { status: 'ready', usage: started.usage } : planUsage.load

  function confirm(plan: TrialPlanCode) {
    setConfirming(plan)
    setTrial({ status: 'idle' })
  }

  function cancel() {
    setConfirming(null)
    setTrial({ status: 'idle' })
  }

  function start(plan: TrialPlanCode) {
    if (trial.status === 'starting') return
    setTrial({ status: 'starting', plan })
    useCase.start(plan)
      .then((usage) => {
        setStarted({ plan, usage })
        setConfirming(null)
        setTrial({ status: 'idle' })
      })
      .catch((error: unknown) => setTrial({ status: 'failed', plan, message: planTrialErrorMessage(error) }))
  }

  return {
    load,
    current: load?.status === 'ready' ? load.usage : null,
    started,
    confirming,
    trial,
    actionOf: (code: PlanCode) => pricingPlanAction(code, load),
    confirm,
    cancel,
    start,
    retry: planUsage.reload,
  }
}
