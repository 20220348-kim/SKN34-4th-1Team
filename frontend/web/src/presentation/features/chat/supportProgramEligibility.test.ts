import { describe, expect, it } from 'vitest'

import { conditionMatchedProgram, relocationReviewRequiredProgram, supportPrograms } from '../../../data/fixtures/supportPrograms'
import { formatSupportProgramEligibilityCounts, getSupportProgramEligibilityKind, groupSupportProgramsByEligibility } from './supportProgramEligibility'

describe('검색 결과 자격 판정 구분', () => {
  it.each([null, 0, 99])('점수가 %s이어도 본문 MATCH 판정을 우선한다', (recommendationScore) => {
    const program = { ...conditionMatchedProgram, recommendationScore }

    expect(getSupportProgramEligibilityKind(program)).toBe('matched')
  })

  it.each([null, 0, 99])('점수가 %s이어도 REVIEW_REQUIRED 판정은 확인 필요로 구분한다', (recommendationScore) => {
    const program = { ...relocationReviewRequiredProgram, recommendationScore }

    expect(getSupportProgramEligibilityKind(program)).toBe('reviewRequired')
  })

  it.each([
    { recommendationScore: null, expected: 'unevaluated' },
    { recommendationScore: 0, expected: 'reviewRequired' },
    { recommendationScore: 99, expected: 'reviewRequired' },
  ])('본문 판정 없이 점수가 $recommendationScore이면 $expected로 구분한다', ({ recommendationScore, expected }) => {
    const program = { ...supportPrograms[0], eligibilityReview: null, recommendationScore }

    expect(getSupportProgramEligibilityKind(program)).toBe(expected)
  })

  it('태그와 점수가 높아도 확인 필요 공고를 조건 확인에 포함하지 않고 최신 목록도 분리한다', () => {
    const latest = { ...supportPrograms[3], recommendationScore: null }
    const programs = [relocationReviewRequiredProgram, supportPrograms[1], latest, conditionMatchedProgram]
    expect(groupSupportProgramsByEligibility(programs)).toEqual({
      matched: [conditionMatchedProgram],
      reviewRequired: [relocationReviewRequiredProgram, supportPrograms[1]],
      latest: [latest],
    })
    expect(formatSupportProgramEligibilityCounts(programs))
      .toBe('조건 확인 공고 1건, 확인 필요 공고 2건, 최신 공고 1건(자격 미평가)')
  })

  it('각 분류의 입력 순서와 미평가 공고의 기존 latest 그룹명을 유지한다', () => {
    const matchedWithoutScore = { ...conditionMatchedProgram, recommendationScore: null }
    const reviewWithoutScore = { ...relocationReviewRequiredProgram, recommendationScore: null }
    const zeroScoreWithoutReview = { ...supportPrograms[0], eligibilityReview: null, recommendationScore: 0 }
    const firstUnevaluated = { ...supportPrograms[0], eligibilityReview: null, recommendationScore: null }
    const secondUnevaluated = { ...supportPrograms[1], eligibilityReview: null, recommendationScore: null }
    const programs = [firstUnevaluated, reviewWithoutScore, matchedWithoutScore,
      zeroScoreWithoutReview, secondUnevaluated, conditionMatchedProgram]

    expect(groupSupportProgramsByEligibility(programs)).toEqual({
      matched: [matchedWithoutScore, conditionMatchedProgram],
      reviewRequired: [reviewWithoutScore, zeroScoreWithoutReview],
      latest: [firstUnevaluated, secondUnevaluated],
    })
    expect(formatSupportProgramEligibilityCounts(programs))
      .toBe('조건 확인 공고 2건, 확인 필요 공고 2건, 최신 공고 2건(자격 미평가)')
  })

  it('빈 결과에서도 조건 확인·확인 필요 건수를 각각 0건으로 안내한다', () => {
    expect(formatSupportProgramEligibilityCounts([])).toBe('조건 확인 공고 0건, 확인 필요 공고 0건')
  })
})
