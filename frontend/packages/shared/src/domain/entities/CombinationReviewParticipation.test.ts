import { describe, expect, it } from 'vitest'
import { unknownParticipation } from './CombinationReview'
import { currentStatusToParticipation, participationToCurrentStatus, showFundingQuestion } from './CombinationReviewParticipation'

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
