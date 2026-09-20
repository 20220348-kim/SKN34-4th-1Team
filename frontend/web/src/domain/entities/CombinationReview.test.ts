import { describe, expect, it } from 'vitest'
import { supportsAutomaticReview, unknownParticipation, validateReviewDraft } from './CombinationReview'

describe('supportsAutomaticReview', () => {
  it.each([
    { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', subProgramId: null },
    { sourceCode: 'KSTARTUP', sourceProgramId: '177911', subProgramId: null },
    { sourceCode: 'MSIT', sourceProgramId: '3186573', subProgramId: null },
    { sourceCode: 'CNTRADE_NOTICE', sourceProgramId: '3862', subProgramId: null },
  ])('accepts a supported official identity: $sourceCode:$sourceProgramId', (program) => {
    expect(supportsAutomaticReview(program)).toBe(true)
  })

  it.each([
    { sourceCode: 'BIZINFO', sourceProgramId: `PBLN_${'1'.repeat(33)}`, subProgramId: null },
    { sourceCode: 'MSIT', sourceProgramId: '0', subProgramId: null },
    { sourceCode: 'MSIT', sourceProgramId: '3186573', subProgramId: '세부사업' },
    { sourceCode: 'KSTARTUP', sourceProgramId: 'PBLN_1', subProgramId: null },
    { sourceCode: 'CNTRADE_NOTICE', sourceProgramId: '0', subProgramId: null },
  ])('rejects an unsupported automatic identity: $sourceCode:$sourceProgramId', (program) => {
    expect(supportsAutomaticReview(program)).toBe(false)
  })
})

describe('validateReviewDraft', () => {
  const program = (sourceProgramId: string) => ({ sourceCode: 'BIZINFO', sourceProgramId, subProgramId: null, participation: unknownParticipation() })

  it('accepts exactly two distinct programs', () => {
    expect(validateReviewDraft({ title: '두 사업 비교', programs: [program('PBLN_1'), program('PBLN_2')] }).programs).toHaveLength(2)
  })

  it('rejects any program count other than two', () => {
    for (const programs of [[program('PBLN_1')], [program('PBLN_1'), program('PBLN_2'), program('PBLN_3')]]) {
      expect(() => validateReviewDraft({ title: '잘못된 사업 수', programs })).toThrow('비교할 서로 다른 사업을 2개 선택해 주세요.')
    }
  })
})
