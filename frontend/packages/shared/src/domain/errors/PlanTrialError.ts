export type PlanTrialErrorCode =
  | 'PLAN_TRIAL_USED'
  | 'PLAN_TRIAL_UNAVAILABLE'
  | 'PLAN_TRIAL_EMAIL_UNVERIFIED'
  | 'AUTHENTICATION_REQUIRED'
  | 'REQUEST_FAILED'
  | 'INVALID_RESPONSE'

/** 출시 전 무료 체험을 시작하지 못했습니다. 서버 원문 대신 HTTP 상태와 안정적인 오류 코드만 담습니다. */
export class PlanTrialError extends Error {
  readonly status: number
  readonly code: PlanTrialErrorCode
  constructor(status: number, code: PlanTrialErrorCode) {
    super(code)
    this.name = 'PlanTrialError'
    this.status = status
    this.code = code
  }
}

/** 체험을 시작하지 못한 이유를 사용자 문장으로 바꿉니다. */
export function planTrialErrorMessage(error: unknown): string {
  if (!(error instanceof PlanTrialError)) return '체험을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.'
  switch (error.code) {
    case 'PLAN_TRIAL_USED': return '이 요금제는 이미 체험했어요. 요금제마다 한 번만 체험할 수 있어요.'
    case 'PLAN_TRIAL_UNAVAILABLE': return '지금 요금제에서는 이 체험을 시작할 수 없어요. 요금제 화면을 다시 불러와 주세요.'
    case 'PLAN_TRIAL_EMAIL_UNVERIFIED': return '이메일 인증을 마친 뒤 체험할 수 있어요.'
    case 'AUTHENTICATION_REQUIRED': return '로그인이 끝났어요. 다시 로그인한 뒤 체험을 시작해 주세요.'
    default: return '체험을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.'
  }
}
