import type { Participation } from './CombinationReview'

export const currentStatusLabels = {
  BEFORE_APPLICATION: '신청 전', APPLICATION: '신청 완료 · 심사 중', NOT_SELECTED: '미선정 · 탈락',
  SELECTED: '선정됨 · 확약 전', COMMITMENT: '확약 제출 완료', AGREEMENT: '협약 체결 · 수행 시작 전',
  IN_PROGRESS: '수행 중', COMPLETED: '수행 완료', STOPPED: '중단 · 포기', UNKNOWN: '잘 모르겠음',
} as const
export type CurrentStatus = keyof typeof currentStatusLabels

const facts: Record<CurrentStatus, Partial<Participation>> = {
  BEFORE_APPLICATION: { applicationSubmitted: 'NO' },
  APPLICATION: { applicationSubmitted: 'YES' },
  NOT_SELECTED: { applicationSubmitted: 'YES', selected: 'NO' },
  SELECTED: { selected: 'YES', commitmentSubmitted: 'NO' },
  COMMITMENT: { commitmentSubmitted: 'YES' },
  AGREEMENT: { agreementSigned: 'YES', executionStatus: 'NOT_STARTED' },
  IN_PROGRESS: { executionStatus: 'IN_PROGRESS' },
  COMPLETED: { executionStatus: 'COMPLETED' },
  STOPPED: { executionStatus: 'STOPPED' },
  UNKNOWN: {},
}

export function participationToCurrentStatus(value: Participation): CurrentStatus {
  if ((value.selected === 'NO' && (value.commitmentSubmitted === 'YES' || value.agreementSigned === 'YES' || value.executionStatus !== 'UNKNOWN'))
    || (value.agreementSigned === 'YES' && value.executionStatus === 'UNKNOWN')
    || (value.agreementSigned === 'NO' && value.executionStatus !== 'UNKNOWN')
    || (value.applicationSubmitted === 'NO' && (value.selected === 'YES' || value.commitmentSubmitted === 'YES' || value.agreementSigned === 'YES' || value.executionStatus !== 'UNKNOWN'))) return 'UNKNOWN'
  if (value.executionStatus === 'STOPPED') return 'STOPPED'
  if (value.executionStatus === 'COMPLETED') return 'COMPLETED'
  if (value.executionStatus === 'IN_PROGRESS') return 'IN_PROGRESS'
  if (value.agreementSigned === 'YES' && value.executionStatus === 'NOT_STARTED') return 'AGREEMENT'
  if (value.commitmentSubmitted === 'YES') return 'COMMITMENT'
  if (value.selected === 'YES' && value.commitmentSubmitted === 'NO') return 'SELECTED'
  if (value.selected === 'NO' && value.applicationSubmitted === 'YES') return 'NOT_SELECTED'
  if (value.applicationSubmitted === 'YES' && value.selected === 'UNKNOWN') return 'APPLICATION'
  if (value.applicationSubmitted === 'NO') return 'BEFORE_APPLICATION'
  return 'UNKNOWN'
}

export function currentStatusToParticipation(status: CurrentStatus, previous: Participation): Participation {
  // Later progress facts conflict with an explicitly earlier current state. Funding remains independent.
  const next = { ...previous, ...facts[status] }
  if (status === 'BEFORE_APPLICATION' || status === 'APPLICATION' || status === 'NOT_SELECTED' || status === 'SELECTED' || status === 'COMMITMENT') {
    next.agreementSigned = 'UNKNOWN'
    next.executionStatus = 'UNKNOWN'
  }
  if (status === 'BEFORE_APPLICATION' || status === 'APPLICATION' || status === 'NOT_SELECTED') next.commitmentSubmitted = 'UNKNOWN'
  if (status === 'BEFORE_APPLICATION' || status === 'APPLICATION') next.selected = 'UNKNOWN'
  if (status === 'BEFORE_APPLICATION') next.applicationSubmitted = 'NO'
  if (status === 'COMMITMENT' || status === 'AGREEMENT' || status === 'IN_PROGRESS' || status === 'COMPLETED' || status === 'STOPPED') {
    if (next.applicationSubmitted === 'NO') next.applicationSubmitted = 'UNKNOWN'
    if (next.selected === 'NO') next.selected = 'UNKNOWN'
  }
  if (status === 'IN_PROGRESS' || status === 'COMPLETED' || status === 'STOPPED') {
    if (next.agreementSigned === 'NO') next.agreementSigned = 'UNKNOWN'
  }
  return next
}

export function showFundingQuestion(status: CurrentStatus, value: Participation): boolean {
  return ['AGREEMENT', 'IN_PROGRESS', 'COMPLETED', 'STOPPED'].includes(status) || value.fundingReceived !== 'UNKNOWN'
}

/**
 * 세 질문 방식(v3)의 사업별 지금 상태 4값(+모름)입니다. 공고 규정이 상대 사업을 나누는 정도(신청만 했음 · 선정되어 수행 중 · 이미 받음)에 맞춥니다.
 * 저장은 새 칸 없이 기존 사실 6개로 하고, 상태는 사실에서 다시 계산합니다(Core도 같은 대응을 씁니다).
 */
export const reviewProgramStatusLabels = {
  UNKNOWN: '모름', NOT_APPLIED: '신청 전', APPLIED: '신청함 · 심사 중', ACTIVE: '선정 · 협약 · 수행 중', FINISHED: '받음 · 종료',
} as const
export type ReviewProgramStatus = keyof typeof reviewProgramStatusLabels

const statusGroups: Record<CurrentStatus, ReviewProgramStatus> = {
  BEFORE_APPLICATION: 'NOT_APPLIED',
  APPLICATION: 'APPLIED', NOT_SELECTED: 'APPLIED',
  SELECTED: 'ACTIVE', COMMITMENT: 'ACTIVE', AGREEMENT: 'ACTIVE', IN_PROGRESS: 'ACTIVE',
  COMPLETED: 'FINISHED', STOPPED: 'FINISHED',
  UNKNOWN: 'UNKNOWN',
}
const statusFacts: Record<Exclude<ReviewProgramStatus, 'UNKNOWN'>, CurrentStatus> = {
  NOT_APPLIED: 'BEFORE_APPLICATION', APPLIED: 'APPLICATION', ACTIVE: 'IN_PROGRESS', FINISHED: 'COMPLETED',
}

/** 저장된 사실 6개를 상태 4값(+모름)으로 읽습니다. 하나의 진행 상태로 읽히지 않는 사실은 모름입니다. */
export function participationToReviewStatus(value: Participation): ReviewProgramStatus {
  return statusGroups[participationToCurrentStatus(value)]
}

/**
 * 고른 상태를 기존 사실 6개로 저장합니다. 이미 같은 상태로 읽히면 사실을 그대로 둬 세부 사실(미선정 · 확약 등)을 지우지 않습니다.
 * 모름은 사실을 바꾸지 않습니다. 다만 다른 상태로 읽히던 사실에서 모름을 고르면 진행 사실만 모름으로 되돌려 고른 값이 그대로 보이게 하고,
 * 진행 상태와 따로 저장하는 교부 여부는 남깁니다.
 */
export function reviewStatusToParticipation(status: ReviewProgramStatus, previous: Participation): Participation {
  if (participationToReviewStatus(previous) === status) return previous
  if (status === 'UNKNOWN') return { ...previous, applicationSubmitted: 'UNKNOWN', selected: 'UNKNOWN', commitmentSubmitted: 'UNKNOWN', agreementSigned: 'UNKNOWN', executionStatus: 'UNKNOWN' }
  return currentStatusToParticipation(statusFacts[status], previous)
}

export const reviewRelationLabels = { sameProject: '같은 과제·제품인가요?', sameCost: '같은 비용 항목에 쓰나요?' } as const
export const reviewRelationAnswerLabels = { YES: '예', NO: '아니오', UNKNOWN: '모름' } as const
