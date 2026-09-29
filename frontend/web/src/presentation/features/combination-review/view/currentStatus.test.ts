import { describe, expect, it } from 'vitest'
import { unknownParticipation } from '../../../../domain/entities/CombinationReview'
import { currentStatusToParticipation, participationToCurrentStatus, showFundingQuestion, type CurrentStatus } from './currentStatus'

describe('current status projection', () => {
  it.each([
    ['BEFORE_APPLICATION', { applicationSubmitted: 'NO' }],
    ['APPLICATION', { applicationSubmitted: 'YES' }],
    ['NOT_SELECTED', { applicationSubmitted: 'YES', selected: 'NO' }],
    ['SELECTED', { selected: 'YES', commitmentSubmitted: 'NO' }],
    ['COMMITMENT', { commitmentSubmitted: 'YES' }],
    ['AGREEMENT', { agreementSigned: 'YES', executionStatus: 'NOT_STARTED' }],
    ['IN_PROGRESS', { executionStatus: 'IN_PROGRESS' }],
    ['COMPLETED', { executionStatus: 'COMPLETED' }],
    ['STOPPED', { executionStatus: 'STOPPED' }],
    ['UNKNOWN', {}],
  ] as const)('maps %s only to known facts', (status, expected) => {
    expect(currentStatusToParticipation(status, unknownParticipation())).toMatchObject(expected)
  })

  it('preserves independent funding and saved facts until the user changes status', () => {
    const saved = { ...unknownParticipation(), selected: 'YES' as const, fundingReceived: 'NO' as const }
    expect(participationToCurrentStatus(saved)).toBe('UNKNOWN')
    expect(currentStatusToParticipation('COMMITMENT', saved)).toMatchObject({ selected: 'YES', commitmentSubmitted: 'YES', fundingReceived: 'NO' })
    expect(showFundingQuestion('UNKNOWN', saved)).toBe(true)
    expect(participationToCurrentStatus({ ...saved, agreementSigned: 'YES', commitmentSubmitted: 'YES' })).toBe('UNKNOWN')
  })

  it('does not infer later facts or turn unknown into no', () => {
    const value = currentStatusToParticipation('SELECTED', unknownParticipation())
    expect(value).toMatchObject({ applicationSubmitted: 'UNKNOWN', selected: 'YES', commitmentSubmitted: 'NO', agreementSigned: 'UNKNOWN', fundingReceived: 'UNKNOWN' })
    expect(participationToCurrentStatus(value)).toBe('SELECTED')
    expect(showFundingQuestion('SELECTED', value)).toBe(false)
  })

  it('keeps directly saved facts when projecting every expressible status', () => {
    for (const status of ['BEFORE_APPLICATION', 'APPLICATION', 'NOT_SELECTED', 'SELECTED', 'COMMITMENT', 'AGREEMENT', 'IN_PROGRESS', 'COMPLETED', 'STOPPED'] as CurrentStatus[]) {
      expect(participationToCurrentStatus(currentStatusToParticipation(status, unknownParticipation()))).toBe(status)
    }
  })
})
