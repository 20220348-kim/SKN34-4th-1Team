import { describe, expect, it } from 'vitest'
import { reviewSchema, runSchema } from './CombinationReviewDto'

const block = (id: string, text: string) => ({ id, programIndex: 0, documentHash: 'a'.repeat(64), locator: 'PDF page 3 part 1', text })
const participation = { applicationSubmitted: 'UNKNOWN', selected: 'UNKNOWN', commitmentSubmitted: 'UNKNOWN', agreementSigned: 'UNKNOWN', executionStatus: 'UNKNOWN', fundingReceived: 'UNKNOWN' }
const program = (sourceProgramId: string) => ({ sourceCode: 'BIZINFO', sourceProgramId, subProgramId: null, participation })
const time = '2026-10-08T09:00:00+09:00'

/** 세 질문 방식(v3) 실행 응답입니다. 신청은 조건부, 함께 수행은 기관 확인, 같은 과제·비용은 불가입니다. */
function v3Run() {
  return {
    id: 40, reviewId: 12, inputRevision: 3, requestKey: '00000000-0000-4000-8000-000000000040', status: 'SUCCEEDED', failureCode: null, startedAt: time, finishedAt: time,
    input: { title: '검토', programs: [program('PBLN_1'), program('PBLN_2')], additionalFacts: '', asOfDate: '2026-10-08' },
    evidence: {
      documents: [{ programIndex: 0, sourceUrl: 'https://www.bizinfo.go.kr/a.pdf', sourcePageUrl: null, fileName: 'a.pdf', format: 'PDF', rawHash: 'a'.repeat(64), textHash: 'b'.repeat(64), parserVersion: 'v', fetchedAt: time }],
      blocks: [block('E0', '최근 2년 이내 동일제품에 대한 동일내용 지원은 중복지원입니다.'), block('E1', '동일한 소비액 인정항목은 중복 정산 불가. 위반 시 환수합니다.')],
      coverageWarnings: [], reviewStatus: 'AUTOMATIC_UNREVIEWED',
    },
    configuration: { contractVersion: 'combination-review-v3', model: 'm', promptVersion: 'sha256:p' },
    analysis: {
      summary: '요약', limitations: ['한계'],
      pairs: [{ firstProgramIndex: 0, secondProgramIndex: 1, stages: [] as unknown[], answers: [
        { question: 'APPLY', verdict: 'CONDITIONAL', explanation: '조건에 따라 달라요.', institutionQuestion: '', consequences: [], citations: [],
          conditions: [{ condition: '최근 2년 안에 같은 제품으로 지원받았다면', result: 'NOT_ALLOWED', citations: [{ evidenceId: 'E0', quote: '동일제품에 대한 동일내용 지원' }] }] },
        { question: 'CONCURRENT', verdict: 'ASK_INSTITUTION', explanation: '규정이 서로 달라요.', institutionQuestion: '어느 쪽 규정이 적용되나요?', conditions: [], consequences: [],
          citations: [{ evidenceId: 'E0', quote: '중복지원' }] },
        { question: 'SAME_SUBJECT', verdict: 'NOT_ALLOWED', explanation: '같은 비용은 안 돼요.', institutionQuestion: '', conditions: [],
          consequences: [{ moment: 'SETTLEMENT', action: '해당 금액 환수', citations: [{ evidenceId: 'E1', quote: '위반 시 환수' }] }],
          citations: [{ evidenceId: 'E1', quote: '중복 정산 불가' }] },
      ] }],
    },
  }
}
type Run = ReturnType<typeof v3Run>
const answers = (run: Run) => run.analysis.pairs[0]!.answers

describe('combination review response contract', () => {
  it('reads a saved review and run snapshot without relation as unknown relation', () => {
    const review = { id: 12, title: '검토', inputRevision: 1, createdAt: time, updatedAt: time, programs: [program('PBLN_1'), program('PBLN_2')] }
    expect(reviewSchema.parse(review).relation).toEqual({ sameProject: 'UNKNOWN', sameCost: 'UNKNOWN' })
    expect(reviewSchema.parse({ ...review, relation: { sameProject: 'YES', sameCost: 'NO' } }).relation).toEqual({ sameProject: 'YES', sameCost: 'NO' })
    expect(reviewSchema.safeParse({ ...review, relation: { sameProject: 'MAYBE', sameCost: 'NO' } }).success).toBe(false)
    expect(runSchema.parse(v3Run()).input.relation).toEqual({ sameProject: 'UNKNOWN', sameCost: 'UNKNOWN' })
  })

  it('accepts a three-question analysis and fills missing optional fields', () => {
    const run = v3Run()
    delete (answers(run)[2] as { institutionQuestion?: string }).institutionQuestion
    const parsed = runSchema.parse(run)
    expect(parsed.analysis!.pairs[0]!.answers.map((answer) => answer.verdict)).toEqual(['CONDITIONAL', 'ASK_INSTITUTION', 'NOT_ALLOWED'])
    expect(parsed.analysis!.pairs[0]!.answers[2]!.institutionQuestion).toBe('')
  })

  it('reads a six-stage answer without answers as an old analysis', () => {
    const run = v3Run()
    const stage = (name: string) => ({ stage: name, judgment: 'NEEDS_FACTS', scope: '', explanation: '', questions: [], requiresInstitutionConfirmation: false, citations: [] })
    const old = { ...run, configuration: { ...run.configuration, contractVersion: 'combination-review-v2' },
      analysis: { ...run.analysis, pairs: [{ firstProgramIndex: 0, secondProgramIndex: 1, stages: ['APPLICATION', 'SELECTION', 'COMMITMENT', 'AGREEMENT', 'EXECUTION', 'FUNDING'].map(stage) }] } }
    expect(runSchema.parse(old).analysis!.pairs[0]!.answers).toEqual([])
    // v2 계약 실행에 세 질문 답이 섞이거나 v3 계약 실행에 단계만 있으면 결과로 쓰지 않는다.
    expect(runSchema.safeParse({ ...old, analysis: { ...old.analysis, pairs: [{ ...old.analysis.pairs[0], answers: answers(run) }] } }).success).toBe(false)
    expect(runSchema.safeParse({ ...old, configuration: run.configuration }).success).toBe(false)
  })

  it.each<[string, (run: Run) => void]>([
    ['answers out of order', (run) => { answers(run).reverse() }],
    ['a missing question', (run) => { answers(run).pop() }],
    ['stages next to answers', (run) => { run.analysis.pairs[0]!.stages = [{}] }],
    ['a definite verdict without a citation', (run) => { answers(run)[2]!.citations = [] }],
    ['a definite verdict with conditions', (run) => { answers(run)[2]!.conditions = answers(run)[0]!.conditions }],
    ['a conditional answer without conditions', (run) => { answers(run)[0]!.conditions = [] }],
    ['a conditional answer without any citation', (run) => { answers(run)[0]!.conditions[0]!.citations = [] }],
    ['an institution check without a question', (run) => { answers(run)[1]!.institutionQuestion = '  ' }],
    ['an institution check without a citation', (run) => { answers(run)[1]!.citations = [] }],
    ['a no-rule answer with conditions', (run) => { answers(run)[1]!.verdict = 'NO_RULE'; answers(run)[1]!.conditions = answers(run)[0]!.conditions }],
    ['an unknown consequence moment', (run) => { answers(run)[2]!.consequences[0]!.moment = 'LATER' }],
    ['an empty consequence action', (run) => { answers(run)[2]!.consequences[0]!.action = '' }],
    ['a consequence quote missing from the source', (run) => { answers(run)[2]!.consequences[0]!.citations[0]!.quote = '원문에 없는 환수' }],
    ['a condition citing an unknown block', (run) => { answers(run)[0]!.conditions[0]!.citations[0]!.evidenceId = 'E9' }],
  ])('rejects %s', (_case, change) => {
    const run = v3Run()
    change(run)
    expect(runSchema.safeParse(run).success).toBe(false)
  })

  it('allows a no-rule answer without citations', () => {
    const run = v3Run()
    Object.assign(answers(run)[1]!, { verdict: 'NO_RULE', institutionQuestion: '', citations: [] })
    expect(runSchema.safeParse(run).success).toBe(true)
  })
})
