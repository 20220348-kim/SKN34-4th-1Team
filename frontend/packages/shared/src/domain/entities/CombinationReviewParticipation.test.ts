import { describe, expect, it } from 'vitest'
import { unknownParticipation, type Participation } from './CombinationReview'
import {
  currentStatusLabels, currentStatusToParticipation, participationToCurrentStatus, participationToReviewStatus, reviewProgramStatusLabels, reviewRelationAnswerLabels,
  reviewRelationLabels, reviewStatusToParticipation, showFundingQuestion, type CurrentStatus, type ReviewProgramStatus,
} from './CombinationReviewParticipation'

describe('participation facts shared by web and mobile', () => {
  it('a new application status does not erase independent historic funding', () => {
    const saved = { ...unknownParticipation(), agreementSigned: 'YES' as const, executionStatus: 'COMPLETED' as const, fundingReceived: 'YES' as const }
    const changed = currentStatusToParticipation('BEFORE_APPLICATION', saved)
    expect(changed).toMatchObject({ applicationSubmitted: 'NO', selected: 'UNKNOWN', agreementSigned: 'UNKNOWN', executionStatus: 'UNKNOWN', fundingReceived: 'YES' })
    expect(showFundingQuestion('BEFORE_APPLICATION', changed)).toBe(true)
  })
  it('contradictory earlier facts become unknown rather than invented positive facts', () => {
    const saved = { ...unknownParticipation(), applicationSubmitted: 'NO' as const, selected: 'NO' as const, agreementSigned: 'NO' as const, fundingReceived: 'NO' as const }
    expect(currentStatusToParticipation('IN_PROGRESS', saved)).toMatchObject({ applicationSubmitted: 'UNKNOWN', selected: 'UNKNOWN', agreementSigned: 'UNKNOWN', executionStatus: 'IN_PROGRESS', fundingReceived: 'NO' })
  })
  it('an agreement without an execution fact cannot be presented as a known sequential status', () => {
    const saved = { ...unknownParticipation(), agreementSigned: 'YES' as const, fundingReceived: 'NO' as const }
    expect(participationToCurrentStatus(saved)).toBe('UNKNOWN')
    expect(showFundingQuestion('UNKNOWN', saved)).toBe(true)
    expect(currentStatusToParticipation('UNKNOWN', saved)).toEqual(saved)
  })
})

describe('four program statuses shared by web, mobile and Core', () => {
  const facts: Record<CurrentStatus, Participation> = Object.fromEntries((Object.keys(currentStatusLabels) as CurrentStatus[])
    .map((status) => [status, currentStatusToParticipation(status, unknownParticipation())])) as Record<CurrentStatus, Participation>

  it.each([
    ['BEFORE_APPLICATION', 'NOT_APPLIED'], ['APPLICATION', 'APPLIED'], ['NOT_SELECTED', 'APPLIED'],
    ['SELECTED', 'ACTIVE'], ['COMMITMENT', 'ACTIVE'], ['AGREEMENT', 'ACTIVE'], ['IN_PROGRESS', 'ACTIVE'],
    ['COMPLETED', 'FINISHED'], ['STOPPED', 'FINISHED'], ['UNKNOWN', 'UNKNOWN'],
  ] as const)('reads saved %s facts as %s', (current, status) => {
    expect(participationToCurrentStatus(facts[current])).toBe(current)
    expect(participationToReviewStatus(facts[current])).toBe(status)
  })

  it('saves a chosen status through the existing representative facts', () => {
    expect(reviewStatusToParticipation('NOT_APPLIED', unknownParticipation())).toEqual(facts.BEFORE_APPLICATION)
    expect(reviewStatusToParticipation('APPLIED', unknownParticipation())).toEqual(facts.APPLICATION)
    expect(reviewStatusToParticipation('ACTIVE', unknownParticipation())).toEqual(facts.IN_PROGRESS)
    expect(reviewStatusToParticipation('FINISHED', unknownParticipation())).toEqual(facts.COMPLETED)
  })

  it('round-trips every chosen status from every saved state and keeps independent funding', () => {
    const contradictory = { ...unknownParticipation(), agreementSigned: 'YES' as const }
    for (const previous of [...Object.values(facts), contradictory].map((value) => ({ ...value, fundingReceived: 'YES' as const }))) {
      for (const status of Object.keys(reviewProgramStatusLabels) as ReviewProgramStatus[]) {
        const next = reviewStatusToParticipation(status, previous)
        expect(participationToReviewStatus(next)).toBe(status)
        expect(next.fundingReceived).toBe('YES')
      }
    }
  })

  it('keeps detailed or contradictory saved facts when the status does not change', () => {
    expect(reviewStatusToParticipation('APPLIED', facts.NOT_SELECTED)).toBe(facts.NOT_SELECTED)
    expect(reviewStatusToParticipation('ACTIVE', facts.COMMITMENT)).toBe(facts.COMMITMENT)
    const contradictory = { ...unknownParticipation(), agreementSigned: 'YES' as const }
    expect(reviewStatusToParticipation('UNKNOWN', contradictory)).toBe(contradictory)
    // 다른 상태로 읽히던 사실에서 모름을 고르면 진행 사실만 모름으로 되돌린다.
    expect(reviewStatusToParticipation('UNKNOWN', { ...facts.IN_PROGRESS, fundingReceived: 'NO' })).toEqual({ ...unknownParticipation(), fundingReceived: 'NO' })
  })

  it('labels statuses and relation answers in the shared wording', () => {
    expect(Object.values(reviewProgramStatusLabels)).toEqual(['모름', '신청 전', '신청함 · 심사 중', '선정 · 협약 · 수행 중', '받음 · 종료'])
    expect(reviewRelationAnswerLabels).toEqual({ YES: '예', NO: '아니오', UNKNOWN: '모름' })
    expect(reviewRelationLabels.sameProject).toBe('같은 과제·제품인가요?')
  })
})
