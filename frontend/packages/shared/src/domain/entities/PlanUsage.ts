export type PlanCode = 'FREE' | 'PLUS' | 'PREMIUM'
export type PlanUsageFeature = 'AI_SEARCH' | 'EVIDENCE_QUESTION' | 'APPLICATION_DRAFT' | 'COMBINATION_REVIEW'
export type PlanUsagePeriod = 'DAY' | 'MONTH'

/**
 * 한 기능의 이번 기간 사용량입니다. limit이 null이면 그 요금제는 아직 한도를 정하지 않아 제한하지 않습니다.
 * 월 한도 기능의 used에는 진행 중인 작업도 들어갑니다.
 */
export type PlanUsageItem = {
  feature: PlanUsageFeature
  period: PlanUsagePeriod
  limit: number | null
  used: number
  /** 다음 초기화 시각(서울 +09:00, ISO 8601)입니다. */
  resetsAt: string
}

/** 한도가 정해진 기능의 사용량입니다. 이용량 줄과 한도 안내는 이 경우에만 그립니다. */
export type LimitedPlanUsageItem = PlanUsageItem & { limit: number }

/** 현재 요금제와 기능별 사용량입니다. 로그인하지 않았으면 plan이 null이고 AI 대화 검색 체험만 있습니다. */
export type PlanUsage = { plan: PlanCode | null; items: PlanUsageItem[] }

export const planLabels: Record<PlanCode, string> = { FREE: '무료', PLUS: '플러스', PREMIUM: '프리미엄' }

export const planUsageFeatureLabels: Record<PlanUsageFeature, string> = {
  AI_SEARCH: 'AI 대화 검색',
  EVIDENCE_QUESTION: '공고 원문 질문',
  APPLICATION_DRAFT: '신청 문서 초안',
  COMBINATION_REVIEW: '중복 지원·수혜 검토',
}

/** 신청 문서 초안은 공고 하나를 한 건으로 세고, 나머지는 실행 횟수로 셉니다. */
const unitOf = (feature: PlanUsageFeature) => (feature === 'APPLICATION_DRAFT' ? '건' : '회')

export function findPlanUsageItem(usage: PlanUsage | null, feature: PlanUsageFeature): PlanUsageItem | null {
  return usage?.items.find((item) => item.feature === feature) ?? null
}

export function hasPlanLimit(item: PlanUsageItem): item is LimitedPlanUsageItem {
  return item.limit !== null
}

export function remainingPlanUses(item: LimitedPlanUsageItem): number {
  return Math.max(0, item.limit - item.used)
}

/**
 * 다 쓰기 전에 알릴 시점입니다. 남은 횟수가 한도의 20%(최소 1회) 이하가 되면 미리 보여 줍니다.
 * 하루 10회는 8회부터, 월 3회는 2회부터(남은 1회), 로그인 전 체험 2회는 1회부터입니다. 한도가 1회 이하거나 없으면 미리 알리지 않습니다.
 */
export function isNearPlanLimit(item: PlanUsageItem): boolean {
  if (item.limit === null || item.limit <= 1) return false
  return item.used >= item.limit - Math.max(1, Math.floor(item.limit * 0.2))
}

export function isPlanLimitReached(item: PlanUsageItem): boolean {
  return item.limit !== null && item.used >= item.limit
}

/**
 * 화면 한 줄에 쓰는 이용량입니다. 사용자가 궁금한 것은 "얼마나 더 쓸 수 있나"이므로 남은 양으로 적습니다.
 * 예: "오늘 2회 남음", "이번 달 1건 남음". 한도가 없으면 남은 양이 없으므로 "오늘 8회 · 제한 없음"처럼 쓴 양을 적습니다.
 */
export function planUsageCountText(item: PlanUsageItem): string {
  const period = item.period === 'DAY' ? '오늘' : '이번 달'
  const unit = unitOf(item.feature)
  if (item.limit === null) return `${period} ${item.used}${unit} · 제한 없음`
  return `${period} ${Math.max(0, item.limit - item.used)}${unit} 남음`
}

/**
 * 한도 중 쓴 양입니다. 예: "10회 중 8회 썼어요". 진행 중인 작업 때문에 한도를 넘겨 세어져도 한도에서 멈춥니다.
 * 한도가 없으면 null입니다.
 */
export function planUsageUsedText(item: PlanUsageItem): string | null {
  if (item.limit === null) return null
  const unit = unitOf(item.feature)
  return `${item.limit}${unit} 중 ${Math.min(item.used, item.limit)}${unit} 썼어요`
}

/** 기능마다 무엇을 한 번으로 세는지입니다. 프로필 도움말과 앱 내 계정 안내가 함께 씁니다. */
export const planUsageCountingRules: Record<PlanUsageFeature, string> = {
  AI_SEARCH: '검색어로 공고를 찾을 때 1회예요. 조건을 정리하는 대화와 필터 검색은 세지 않고, 검색이 실패하면 돌려줘요.',
  EVIDENCE_QUESTION: '질문을 보낼 때 1회예요. 답을 받지 못하고 실패하면 돌려줘요.',
  APPLICATION_DRAFT: '새 공고의 양식 분석이나 초안 만들기를 처음 시작할 때 1건이에요. 같은 공고는 다시 분석·생성해도 늘지 않아요.',
  COMBINATION_REVIEW: '[검토 실행]을 누를 때 1회예요. 진행 중인 검토도 세고, 실패한 실행은 빠져요.',
}

/** 신청 문서와 중복 검토는 지워도 그 달에 쓴 양이 돌아오지 않습니다. */
export const planUsageDeletionNote = '신청 문서와 중복 검토는 지워도 그 달에 쓴 횟수가 돌아오지 않아요.'

/** 서울 날짜 그대로 읽습니다. 기기 시간대로 바꾸면 월초 0시가 전날로 보일 수 있습니다. */
function seoulMonthDay(resetsAt: string): string | null {
  const match = /^\d{4}-(\d{2})-(\d{2})T/.exec(resetsAt)
  return match ? `${Number(match[1])}월 ${Number(match[2])}일` : null
}

/**
 * 하루 기간이 끝날 때까지 남은 시간입니다. 길어야 24시간이라 "약 3시간 뒤"처럼 시간 단위로 반올림해 적습니다. 시계 시각만 적으면
 * 오늘인지 내일인지, 어느 시간대인지 헷갈리므로 남은 시간으로 셉니다. 1시간이 안 남았으면 "1시간 안에", 이미 지났으면 "곧",
 * 읽을 수 없으면 null입니다.
 */
function timeUntil(resetsAt: string, now: number): string | null {
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return null
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return '곧'
  if (minutes < 60) return '1시간 안에'
  return `약 ${Math.round(minutes / 60)}시간 뒤에`
}

/**
 * 예: "약 3시간 뒤에 다시 채워져요.", "11월 1일에 다시 채워져요." 하루 한도는 [now] 기준 남은 시간으로, 달 한도는 날짜로 적습니다.
 */
export function planUsageResetText(item: Pick<PlanUsageItem, 'period' | 'resetsAt'>, now: number = Date.now()): string {
  if (item.period === 'DAY') {
    const until = timeUntil(item.resetsAt, now)
    return until ? `${until} 다시 채워져요.` : '자정에 다시 채워져요.'
  }
  const date = seoulMonthDay(item.resetsAt)
  return date ? `${date}에 다시 채워져요.` : '다음 달 1일에 다시 채워져요.'
}

export type PlanQuotaExceeded = Pick<PlanUsageItem, 'feature' | 'period' | 'resetsAt'> & { limit: number; plan: PlanCode | null }

/** 한도를 다 썼을 때 사용자에게 보여 줄 한 문단입니다. 계속 쓸 수 있는 다른 방법을 함께 알립니다. */
export function planQuotaExceededMessage(quota: PlanQuotaExceeded, now: number = Date.now()): string {
  const reset = planUsageResetText(quota, now)
  switch (quota.feature) {
    case 'AI_SEARCH':
      return quota.plan === null
        ? `로그인 전 체험 ${quota.limit}회를 모두 썼어요. 로그인하면 회원 한도로 이어서 검색할 수 있고, 필터 검색은 계속 쓸 수 있어요.`
        : `오늘 AI 대화 검색 ${quota.limit}회를 모두 썼어요. ${reset} 필터 검색은 계속 쓸 수 있어요.`
    case 'EVIDENCE_QUESTION':
      return `오늘 공고 원문 질문 ${quota.limit}회를 모두 썼어요. ${reset}`
    case 'APPLICATION_DRAFT':
      return `이번 달 신청 문서 초안 ${quota.limit}건을 모두 썼어요. 이미 시작한 공고의 문서는 계속 만들 수 있어요. ${reset}`
    case 'COMBINATION_REVIEW':
      return `이번 달 중복 검토 ${quota.limit}회를 모두 썼어요. 진행 중인 검토도 횟수에 들어가요. ${reset}`
  }
}

export const quotaUnavailableMessage = '지금은 이용량을 확인할 수 없어 실행하지 않았어요. 잠시 후 다시 시도해 주세요.'
