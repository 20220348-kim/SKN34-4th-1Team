import { z } from 'zod'
import { reviewStages } from '../../domain/entities/CombinationReview'

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
export const reviewSummarySchema = z.object({ id, title: z.string(), inputRevision: id, createdAt: time, updatedAt: time })
export const reviewSchema = reviewSummarySchema.extend({ programs })
export const reviewPageSchema = z.object({ items: z.array(reviewSummarySchema).max(50), nextBeforeId: id.nullable() })
export const runRequestSchema = z.object({ expectedRevision: id, requestKey: z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/), additionalFacts: z.string().max(8000) })
export const runSummarySchema = z.object({ id, inputRevision: id, status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED', 'UNKNOWN']), failureCode: z.string().nullable(), startedAt: time, finishedAt: time.nullable() })
export const runPageSchema = z.object({ items: z.array(runSummarySchema).max(50), nextBeforeId: id.nullable() })
export const runSchema = runSummarySchema.extend({
  reviewId: id, requestKey: runRequestSchema.shape.requestKey,
  input: z.object({ title: z.string(), programs, additionalFacts: z.string(), asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
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
  analysis: z.object({ summary: z.string(), limitations: z.array(z.string()), pairs: z.array(z.object({ firstProgramIndex: index, secondProgramIndex: index,
    stages: z.array(z.object({ stage: z.enum(reviewStages), judgment: z.enum(['RESTRICTION_APPLIES', 'PERMISSION_IN_SCOPE', 'NEEDS_FACTS', 'INSUFFICIENT_EVIDENCE', 'CONFLICTING_EVIDENCE']),
      scope: z.string(), explanation: z.string(), questions: z.array(z.string()), requiresInstitutionConfirmation: z.boolean(), citations: z.array(z.object({ evidenceId: z.string(), quote: z.string().min(1) })) })).length(6),
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
  for (const pair of pairs) {
    if (pair.firstProgramIndex >= pair.secondProgramIndex || pair.secondProgramIndex >= count || new Set(pair.stages.map((s) => s.stage)).size !== 6) fail()
    for (const stage of pair.stages) {
      if (stage.citations.some((c) => !blocks.some((b) => b.id === c.evidenceId && b.text.includes(c.quote)))) fail()
      if (['RESTRICTION_APPLIES', 'PERMISSION_IN_SCOPE'].includes(stage.judgment) && (!stage.citations.length || stage.requiresInstitutionConfirmation)) fail()
    }
  }
})
export const reviewProblemSchema = z.object({ code: z.string(), runId: id.optional() })
