import { z } from 'zod'
import { reviewAnswerVerdicts, reviewConsequenceMoments, reviewQuestionKinds, reviewStages, unknownRelation } from '../../domain/entities/CombinationReview'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
// 새 실행은 두 공고만 만들지만 정책 변경 전 3개 비교 실행의 programIndex=2도 조회한다.
const index = z.number().int().min(0).max(2)
const time = z.string().datetime({ offset: true })
const answer = z.enum(['YES', 'NO', 'UNKNOWN'])
export const reviewProgramSchema = z.object({
  sourceCode: z.string().min(1), sourceProgramId: z.string().min(1), subProgramId: z.string().nullable(),
  participation: z.object({ applicationSubmitted: answer, selected: answer, commitmentSubmitted: answer, agreementSigned: answer,
    executionStatus: z.enum(['UNKNOWN', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'STOPPED']), fundingReceived: answer }),
})
// 정책 변경 전 저장한 3개 비교의 이력과 결과도 조회할 수 있어야 한다. 새 입력은 Domain에서 정확히 2개로 제한한다.
const programs = z.array(reviewProgramSchema).min(2).max(3)
// 관계 두 칸은 선택 입력이다. 이 칸이 생기기 전 저장한 검토 · 실행 스냅샷과 이전 서버 응답은 모두 모름으로 읽는다.
const relation = z.object({ sameProject: answer, sameCost: answer }).optional().transform((value) => value ?? unknownRelation())
export const reviewSummarySchema = z.object({ id, title: z.string(), inputRevision: id, createdAt: time, updatedAt: time })
export const reviewSchema = reviewSummarySchema.extend({ programs, relation })
export const runRequestSchema = z.object({ expectedRevision: id, requestKey: z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/), additionalFacts: z.string().max(8000) })
export const runSummarySchema = z.object({ id, inputRevision: id, status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED', 'UNKNOWN']), failureCode: z.string().nullable(), startedAt: time, finishedAt: time.nullable() })
// 목록 행에는 가장 최근 실행 요약이 붙는다. 실행 전이면 null이며, 이 필드가 없던 서버 응답도 실행 정보 없음으로 읽는다.
export const reviewListItemSchema = reviewSummarySchema.extend({ latestRun: runSummarySchema.nullable().optional().transform((run) => run ?? null) })
export const reviewPageSchema = z.object({ items: z.array(reviewListItemSchema).max(50), nextBeforeId: id.nullable() })
export const runPageSchema = z.object({ items: z.array(runSummarySchema).max(50), nextBeforeId: id.nullable() })
const citations = z.array(z.object({ evidenceId: z.string(), quote: z.string().min(1) }))
const answerSchema = z.object({
  question: z.enum(reviewQuestionKinds), verdict: z.enum(reviewAnswerVerdicts), explanation: z.string().min(1),
  conditions: z.array(z.object({ condition: z.string().min(1), result: z.enum(['ALLOWED', 'NOT_ALLOWED']), citations: citations.max(8) })).max(4),
  consequences: z.array(z.object({ moment: z.enum(reviewConsequenceMoments), action: z.string().min(1), citations: citations.max(8) })).max(4),
  institutionQuestion: z.string().nullable().optional().transform((value) => value ?? ''),
  citations: citations.max(8),
})
/** 세 질문 답의 판정별 필수 요소입니다(ai-service · Core Facade와 같은 규칙). */
function answerShapeValid(answer: z.infer<typeof answerSchema>): boolean {
  const citationCount = answer.citations.length + answer.conditions.reduce((count, condition) => count + condition.citations.length, 0)
  if (answer.verdict === 'ALLOWED' || answer.verdict === 'NOT_ALLOWED') return answer.citations.length > 0 && answer.conditions.length === 0
  if (answer.verdict === 'CONDITIONAL') return answer.conditions.length > 0 && citationCount > 0
  if (answer.verdict === 'NO_RULE') return answer.conditions.length === 0
  return answer.institutionQuestion.trim().length > 0 && citationCount > 0
}
export const runSchema = runSummarySchema.extend({
  reviewId: id, requestKey: runRequestSchema.shape.requestKey,
  input: z.object({ title: z.string(), programs, relation, additionalFacts: z.string(), asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  evidence: z.object({
    documents: z.array(z.object({
      programIndex: index,
      sourceUrl: z.string().url().refine((s) => s.startsWith('https://')),
      sourcePageUrl: z.string().url().refine((s) => s.startsWith('https://')).nullable(),
      fileName: z.string(), format: z.string(), rawHash: z.string(), textHash: z.string(), parserVersion: z.string(), fetchedAt: time,
    })),
    blocks: z.array(z.object({ id: z.string(), programIndex: index, documentHash: z.string(), locator: z.string(), text: z.string() })),
    coverageWarnings: z.array(z.string()), reviewStatus: z.literal('AUTOMATIC_UNREVIEWED'),
  }).nullable(),
  configuration: z.object({ contractVersion: z.string(), model: z.string(), promptVersion: z.string() }).nullable(),
  // 여섯 단계 방식(v2)은 stages 6개, 세 질문 방식(v3)은 answers 3개이고 다른 쪽은 비어 있다. answers가 없던 응답은 v2다.
  analysis: z.object({ summary: z.string(), limitations: z.array(z.string()), pairs: z.array(z.object({ firstProgramIndex: index, secondProgramIndex: index,
    stages: z.array(z.object({ stage: z.enum(reviewStages), judgment: z.enum(['RESTRICTION_APPLIES', 'PERMISSION_IN_SCOPE', 'NEEDS_FACTS', 'INSUFFICIENT_EVIDENCE', 'CONFLICTING_EVIDENCE']),
      scope: z.string(), explanation: z.string(), questions: z.array(z.string()), requiresInstitutionConfirmation: z.boolean(), citations })),
    answers: z.array(answerSchema).optional().transform((value) => value ?? []),
  })) }).nullable(),
}).superRefine((run, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: '실행 결과 참조 계약 오류' })
  if ((run.status === 'SUCCEEDED') !== (run.analysis !== null)) fail()
  if (run.status === 'SUCCEEDED' && (!run.evidence || !run.configuration)) fail()
  const count = run.input.programs.length
  const blocks = run.evidence?.blocks ?? []
  if (new Set(blocks.map((b) => b.id)).size !== blocks.length) fail()
  if (run.evidence?.documents.some((d) => d.programIndex >= count)) fail()
  if (blocks.some((b) => b.programIndex >= count || !run.evidence?.documents.some((d) => d.programIndex === b.programIndex && d.rawHash === b.documentHash))) fail()
  const pairs = run.analysis?.pairs ?? []
  if (run.analysis && (pairs.length !== count * (count - 1) / 2 || new Set(pairs.map((p) => `${p.firstProgramIndex}:${p.secondProgramIndex}`)).size !== pairs.length)) fail()
  const cited = (citation: { evidenceId: string; quote: string }) => blocks.some((b) => b.id === citation.evidenceId && b.text.includes(citation.quote))
  const questionMode = pairs.some((pair) => pair.answers.length > 0)
  const contractVersion = run.configuration?.contractVersion
  if ((contractVersion === 'combination-review-v3' && run.analysis && !questionMode) || (contractVersion === 'combination-review-v2' && questionMode)) fail()
  for (const pair of pairs) {
    if (pair.firstProgramIndex >= pair.secondProgramIndex || pair.secondProgramIndex >= count) fail()
    if (questionMode) {
      // 세 질문 방식: 단계 없이 세 질문을 정해진 순서로 한 번씩 답한다.
      if (pair.stages.length !== 0 || pair.answers.length !== reviewQuestionKinds.length || pair.answers.some((a, i) => a.question !== reviewQuestionKinds[i])) fail()
      for (const answer of pair.answers) {
        if (!answerShapeValid(answer)) fail()
        if ([answer.citations, ...answer.conditions.map((c) => c.citations), ...answer.consequences.map((c) => c.citations)].flat().some((c) => !cited(c))) fail()
      }
      continue
    }
    if (pair.answers.length !== 0 || pair.stages.length !== 6 || new Set(pair.stages.map((s) => s.stage)).size !== 6) fail()
    for (const stage of pair.stages) {
      if (stage.citations.some((c) => !cited(c))) fail()
      if (['RESTRICTION_APPLIES', 'PERMISSION_IN_SCOPE'].includes(stage.judgment) && (!stage.citations.length || stage.requiresInstitutionConfirmation)) fail()
    }
  }
})
export const reviewProblemSchema = z.object({ code: z.string(), runId: id.optional() })
