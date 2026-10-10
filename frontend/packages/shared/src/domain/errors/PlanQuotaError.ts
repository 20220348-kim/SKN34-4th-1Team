import { type PlanQuotaExceeded, planQuotaExceededMessage, quotaUnavailableMessage } from '../entities/PlanUsage'

/** 요금제 한도를 다 써서 Core가 실행하지 않았습니다. 화면 문구는 [message]에 이미 담겨 있습니다. */
export class PlanQuotaExceededError extends Error {
  readonly quota: PlanQuotaExceeded
  constructor(quota: PlanQuotaExceeded) {
    super(planQuotaExceededMessage(quota))
    this.name = 'PlanQuotaExceededError'
    this.quota = quota
  }
}

/** 사용량을 확인할 수 없어 Core가 유료 기능을 실행하지 않았습니다. 정상 응답으로 숨기지 않고 다시 시도를 안내합니다. */
export class QuotaUnavailableError extends Error {
  constructor() {
    super(quotaUnavailableMessage)
    this.name = 'QuotaUnavailableError'
  }
}
