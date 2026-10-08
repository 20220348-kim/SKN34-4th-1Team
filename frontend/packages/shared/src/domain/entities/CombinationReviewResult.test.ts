import { describe, expect, it } from 'vitest'
import { reviewStages, unknownParticipation, type ReviewAnswer, type ReviewAnswerVerdict, type ReviewRun } from './CombinationReview'
import {
  reviewAnswerHeadline, reviewAnswersOf, reviewAnswerToneOf, reviewAnswerVerdictLabels, reviewConsequenceMomentLabels, reviewHeadline, reviewQuestionLabels, reviewQuestions,
  type ReviewJudgment, type ReviewStageResult,
} from './CombinationReviewResult'

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

const citation = { evidenceId: 'E0', quote: '중복 지원 불가' }
function answer(question: ReviewAnswer['question'], verdict: ReviewAnswerVerdict): ReviewAnswer {
  return {
    question, verdict, explanation: '설명', institutionQuestion: verdict === 'ASK_INSTITUTION' ? '어느 규정이 적용되나요?' : '', consequences: [],
    conditions: verdict === 'CONDITIONAL' ? [{ condition: '같은 비용 항목이면', result: 'NOT_ALLOWED', citations: [citation] }] : [],
    citations: verdict === 'NO_RULE' || verdict === 'CONDITIONAL' ? [] : [citation],
  }
}
const answersOf = (apply: ReviewAnswerVerdict, concurrent: ReviewAnswerVerdict, same: ReviewAnswerVerdict) =>
  [answer('APPLY', apply), answer('CONCURRENT', concurrent), answer('SAME_SUBJECT', same)]

describe('three-question result shared by web and mobile', () => {
  it('labels questions, verdicts and consequence moments in the shared wording', () => {
    expect(Object.values(reviewQuestionLabels)).toEqual(['둘 다 신청할 수 있나요?', '둘 다 되면 함께 수행할 수 있나요?', '같은 과제·비용으로 두 번 받는 것은 아닌가요?'])
    expect(Object.values(reviewAnswerVerdictLabels)).toEqual(['가능', '조건부', '불가', '규정 없음', '기관 확인'])
    expect(Object.values(reviewConsequenceMomentLabels)).toEqual(['평가', '선정', '협약', '수행', '정산·지급', '사후'])
  })
  it.each([
    ['NOT_ALLOWED', 'warn'], ['ASK_INSTITUTION', 'ask'], ['CONDITIONAL', 'conditional'], ['NO_RULE', 'neutral'], ['ALLOWED', 'ok'],
  ] as const)('gives %s the %s tone', (verdict, tone) => {
    expect(reviewAnswerToneOf(verdict)).toBe(tone)
  })
  it('picks the title by verdict priority and lists the other questions in the same order', () => {
    expect(reviewAnswerHeadline(answersOf('CONDITIONAL', 'ALLOWED', 'NOT_ALLOWED'))).toEqual({
      tone: 'warn', title: '같은 과제·비용으로 두 번 받을 수 없어요', reason: '신청은 조건에 따라 달라요. 함께 수행은 가능해요.',
    })
    expect(reviewAnswerHeadline(answersOf('NOT_ALLOWED', 'NO_RULE', 'NOT_ALLOWED'))).toEqual({
      tone: 'warn', title: '두 공고에 함께 신청할 수 없어요', reason: '같은 과제·비용도 불가예요. 함께 수행은 관련 규정을 찾지 못했어요.',
    })
    expect(reviewAnswerHeadline(answersOf('CONDITIONAL', 'ASK_INSTITUTION', 'NO_RULE'))).toEqual({
      tone: 'ask', title: '함께 수행은 기관 확인이 필요해요', reason: '신청은 조건에 따라 달라요. 같은 과제·비용은 관련 규정을 찾지 못했어요.',
    })
    expect(reviewAnswerHeadline(answersOf('CONDITIONAL', 'CONDITIONAL', 'ALLOWED'))).toEqual({
      tone: 'conditional', title: '신청 · 함께 수행은 조건에 따라 달라요', reason: '같은 과제·비용은 가능해요.',
    })
    expect(reviewAnswerHeadline(answersOf('ALLOWED', 'NO_RULE', 'ALLOWED'))).toEqual({
      tone: 'neutral', title: '함께 수행에 관한 규정을 찾지 못했어요', reason: '신청 · 같은 과제·비용은 가능해요.',
    })
  })
  it('uses a fixed reason when every question has the same verdict, and never calls missing rules permission', () => {
    expect(reviewAnswerHeadline(answersOf('ALLOWED', 'ALLOWED', 'ALLOWED'))).toMatchObject({ tone: 'ok', title: '찾은 원문 범위에서는 세 질문 모두 가능해요', reason: expect.stringContaining('보장하지는 않아요') })
    expect(reviewAnswerHeadline(answersOf('NO_RULE', 'NO_RULE', 'NO_RULE'))).toEqual({ tone: 'neutral', title: '두 공고에서 관련 규정을 찾지 못했어요', reason: '규정을 찾지 못한 것이 허용을 뜻하지는 않아요.' })
    expect(reviewAnswerHeadline(answersOf('NOT_ALLOWED', 'NOT_ALLOWED', 'NOT_ALLOWED'))).toMatchObject({ title: '두 공고에 함께 신청할 수 없어요', reason: '세 질문 모두 공고가 정한 제한이 적용돼요.' })
    expect(reviewAnswerHeadline(answersOf('CONDITIONAL', 'CONDITIONAL', 'CONDITIONAL')).reason).toBe('아래 조건 가운데 내 상황에 맞는 것을 확인해 주세요.')
    // 받은 순서와 관계없이 질문 순서로 읽는다.
    expect(reviewAnswerHeadline([...answersOf('ALLOWED', 'NOT_ALLOWED', 'NOT_ALLOWED')].reverse()).title).toBe('둘 다 되어도 함께 수행할 수 없어요')
  })
  it('tells a three-question analysis from a six-stage one', () => {
    const analysis = (answers: ReviewAnswer[] | undefined): ReviewRun['analysis'] => ({ summary: '', limitations: [], pairs: [{ firstProgramIndex: 0, secondProgramIndex: 1, stages: [], ...(answers ? { answers } : {}) }] })
    expect(reviewAnswersOf(analysis([...answersOf('ALLOWED', 'NO_RULE', 'CONDITIONAL')].reverse()))?.map((item) => item.question)).toEqual(['APPLY', 'CONCURRENT', 'SAME_SUBJECT'])
    expect(reviewAnswersOf(analysis(undefined))).toBeNull()
    expect(reviewAnswersOf(analysis([]))).toBeNull()
    expect(reviewAnswersOf(null)).toBeNull()
  })
})
