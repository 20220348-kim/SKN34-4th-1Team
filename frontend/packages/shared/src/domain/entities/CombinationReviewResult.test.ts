import { describe, expect, it } from 'vitest'
import { reviewStages, unknownParticipation } from './CombinationReview'
import { reviewHeadline, reviewQuestions, type ReviewJudgment, type ReviewStageResult } from './CombinationReviewResult'

const stagesOf = (judgments: ReviewJudgment[], questions: (index: number) => string[] = () => []): ReviewStageResult[] =>
  reviewStages.map((stage, index) => ({ stage, judgment: judgments[index]!, scope: '', explanation: '', questions: questions(index), requiresInstitutionConfirmation: false, citations: [] }))

describe('review result headline shared by web and mobile', () => {
  it('a restriction wins over conflicts and names both stage groups', () => {
    const headline = reviewHeadline(stagesOf(['NEEDS_FACTS', 'CONFLICTING_EVIDENCE', 'RESTRICTION_APPLIES', 'NEEDS_FACTS', 'RESTRICTION_APPLIES', 'PERMISSION_IN_SCOPE']))
    expect(headline).toEqual({ verdict: 'warn', title: '함께 진행하면 문제가 될 수 있는 단계가 있어요', reason: '확약 · 수행 단계에 공고가 정한 제한이 적용돼요. 선정 단계는 공고 내용이 서로 달라요.' })
  })
  it('a conflict without a restriction asks for institution confirmation', () => {
    expect(reviewHeadline(stagesOf(['NEEDS_FACTS', 'NEEDS_FACTS', 'CONFLICTING_EVIDENCE', 'NEEDS_FACTS', 'NEEDS_FACTS', 'NEEDS_FACTS'])))
      .toMatchObject({ verdict: 'warn', title: '공고 내용이 서로 달라 기관 확인이 필요해요', reason: expect.stringContaining('확약 단계') })
  })
  it('only an all-permission result says nothing blocked it, still without a guarantee', () => {
    const headline = reviewHeadline(stagesOf(Array(6).fill('PERMISSION_IN_SCOPE')))
    expect(headline.verdict).toBe('ok')
    expect(headline.reason).toContain('보장하지는 않아요')
    expect(reviewHeadline(stagesOf([...Array(5).fill('PERMISSION_IN_SCOPE'), 'NEEDS_FACTS'])).verdict).toBe('info')
  })
  it('an undecided result explains whether facts or evidence are missing', () => {
    const missingBoth = stagesOf(['NEEDS_FACTS', 'INSUFFICIENT_EVIDENCE', 'NEEDS_FACTS', 'PERMISSION_IN_SCOPE', 'NEEDS_FACTS', 'NEEDS_FACTS'])
    const answered = { ...unknownParticipation(), applicationSubmitted: 'YES' as const }
    expect(reviewHeadline(missingBoth, [answered, unknownParticipation()])).toEqual({
      verdict: 'info', title: '두 공고를 함께 진행해도 되는지 아직 정할 수 없어요',
      reason: '공고에서 서로를 막는 조항은 찾지 못했고, 신청 · 확약 · 수행 · 교부 단계는 내 정보가, 선정 단계는 공식 근거가 더 필요해요.',
    })
    expect(reviewHeadline(missingBoth, [unknownParticipation(), unknownParticipation()]).reason).toBe('공고에서 서로를 막는 조항은 찾지 못했고, 내 참여 상태가 모두 미확인이에요.')
    expect(reviewHeadline(stagesOf(Array(6).fill('INSUFFICIENT_EVIDENCE')), [unknownParticipation()]).reason).toContain('공식 근거가 더 필요해요')
  })
})

describe('review questions shared by web and mobile', () => {
  it('picks one unseen question per stage, warning stages first, and keeps every question once in the full list', () => {
    const stages = stagesOf(['NEEDS_FACTS', 'NEEDS_FACTS', 'NEEDS_FACTS', 'RESTRICTION_APPLIES', 'PERMISSION_IN_SCOPE', 'INSUFFICIENT_EVIDENCE'], (index) => [
      [' 신청서를 냈나요? ', '같은 과제인가요?'],
      ['신청서를 냈나요?', '선정됐나요?'],
      [],
      ['협약을 맺었나요?'],
      ['같은 과제인가요?'],
      ['', '교부받았나요?'],
    ][index]!)
    const { priority, all } = reviewQuestions(stages)
    expect(priority).toEqual([
      { stage: 'AGREEMENT', text: '협약을 맺었나요?' },
      { stage: 'APPLICATION', text: '신청서를 냈나요?' },
      { stage: 'SELECTION', text: '선정됐나요?' },
      { stage: 'FUNDING', text: '교부받았나요?' },
    ])
    expect(all.map((question) => question.text)).toEqual(['협약을 맺었나요?', '신청서를 냈나요?', '같은 과제인가요?', '선정됐나요?', '교부받았나요?'])
    expect(reviewQuestions(stages, 2).priority).toHaveLength(2)
  })
})
