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
