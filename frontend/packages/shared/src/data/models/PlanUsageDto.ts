import { z } from 'zod'
import { PlanQuotaExceededError, QuotaUnavailableError } from '../../domain/errors/PlanQuotaError'
import { PlanTrialError, type PlanTrialErrorCode } from '../../domain/errors/PlanTrialError'

export const planCodeSchema = z.enum(['FREE', 'PLUS', 'PREMIUM'])
export const planUsageFeatureSchema = z.enum(['AI_SEARCH', 'EVIDENCE_QUESTION', 'APPLICATION_DRAFT', 'COMBINATION_REVIEW'])
export const planUsagePeriodSchema = z.enum(['DAY', 'MONTH', 'PLAN'])
export const trialPlanCodeSchema = z.enum(['PLUS', 'PREMIUM'])
export const planSourceSchema = z.enum(['OPERATOR', 'TRIAL'])
/** Core는 서울 시각(+09:00)으로 이번 기간이 끝나는 때를 보냅니다. */
const resetsAtSchema = z.iso.datetime({ offset: true })

/** limit이 null이면 한도를 두지 않은 것이라 제한하지 않습니다. */
export const planUsageItemSchema = z.object({
  feature: planUsageFeatureSchema,
  period: planUsagePeriodSchema,
  limit: z.number().int().min(0).nullable(),
  used: z.number().int().min(0),
  resetsAt: resetsAtSchema,
})

/** 현재 요금제와 기능별 사용량입니다. 앱이 서버보다 늦게 갱신돼도 모르는 기능 한 줄 때문에 전체를 버리지 않습니다. */
export const planUsageSchema = z.object({
  plan: planCodeSchema.nullable(),
  /** 유료 이용권이 끝나는 때입니다. 이 값을 보내지 않던 Core와도 맞도록 없으면 null로 읽습니다. */
  planEndsAt: resetsAtSchema.nullish().transform((value) => value ?? null),
  /** 체험 기능이 없던 Core와도 맞도록 없거나 모르는 값이면 출처 없음·시작할 체험 없음으로 읽습니다. */
  planSource: planSourceSchema.nullish().catch(null).transform((value) => value ?? null),
  trialsAvailable: z.array(z.unknown()).max(4).nullish().catch(null).transform((plans) => (plans ?? []).flatMap((plan) => {
    const parsed = trialPlanCodeSchema.safeParse(plan)
    return parsed.success ? [parsed.data] : []
  })),
  items: z.array(z.unknown()).max(16).transform((items) => items.flatMap((item) => {
    const parsed = planUsageItemSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })),
})

/** 요금제 한도를 다 쓴 429 문제 응답입니다. 분당 요청 제한(SUPPORT_PROGRAM_RATE_LIMITED)과 다른 계약입니다. */
export const planQuotaExceededProblemSchema = z.object({
  status: z.literal(429),
  code: z.literal('PLAN_QUOTA_EXCEEDED'),
  feature: planUsageFeatureSchema,
  period: planUsagePeriodSchema,
  plan: planCodeSchema.nullable(),
  limit: z.number().int().min(0),
  used: z.number().int().min(0),
  resetsAt: resetsAtSchema,
})

/** 출시 전 무료 체험을 시작하지 못한 문제 응답의 코드입니다. 모르는 코드는 REQUEST_FAILED로 읽습니다. */
const planTrialProblemSchema = z.object({
  code: z.enum(['PLAN_TRIAL_USED', 'PLAN_TRIAL_UNAVAILABLE', 'PLAN_TRIAL_EMAIL_UNVERIFIED', 'AUTHENTICATION_REQUIRED']),
})

/** 체험 시작 실패 응답을 오류로 바꿉니다. 서버 원문 대신 상태와 안정적인 코드만 남깁니다. */
export function readPlanTrialProblem(status: number, body: unknown): PlanTrialError {
  const parsed = planTrialProblemSchema.safeParse(body)
  const code: PlanTrialErrorCode = parsed.success ? parsed.data.code : status === 401 ? 'AUTHENTICATION_REQUIRED' : 'REQUEST_FAILED'
  return new PlanTrialError(status, code)
}

/** 사용량을 확인할 수 없어 유료 기능을 실행하지 않은 503 문제 응답입니다. */
export const quotaUnavailableProblemSchema = z.object({
  status: z.literal(503),
  code: z.literal('QUOTA_UNAVAILABLE'),
})

/** 문제 응답 본문이 요금제 한도 계약(429 PLAN_QUOTA_EXCEEDED, 503 QUOTA_UNAVAILABLE)이면 오류로 바꾸고, 아니면 null입니다. */
export function readPlanQuotaProblem(status: number, body: unknown): PlanQuotaExceededError | QuotaUnavailableError | null {
  if (status === 429) {
    const parsed = planQuotaExceededProblemSchema.safeParse(body)
    if (!parsed.success) return null
    const { feature, period, plan, limit, resetsAt } = parsed.data
    return new PlanQuotaExceededError({ feature, period, plan, limit, resetsAt })
  }
  if (status === 503 && quotaUnavailableProblemSchema.safeParse(body).success) return new QuotaUnavailableError()
  return null
}
