import { z } from 'zod'

const count = z.number().int().nonnegative()
export const applicationOnlineInputGuideSchema = z.object({
  preparationId: z.number().int().positive(), inputRevision: z.number().int().positive(),
  totalCount: count, readyCount: count, needsReviewCount: count, missingCount: count, directInputCount: count,
  externalMappingVerified: z.boolean(),
  officialApplicationUrl: z.string().url().refine((value) => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password
  }).nullable(),
  items: z.array(z.object({
    fieldId: z.string().min(1).nullable(), sourceControlId: z.string().min(1).nullable().default(null), label: z.string().min(1), required: z.boolean(),
    status: z.enum(['READY', 'NEEDS_REVIEW', 'MISSING', 'DIRECT_INPUT']),
    answer: z.string().min(1).nullable(), inputMode: z.enum(['UNKNOWN', 'SHORT_TEXT', 'LONG_TEXT', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'DROPDOWN']),
    options: z.array(z.string().min(1)), copyable: z.boolean(),
  })),
  savedAnswers: z.array(z.object({ fieldId: z.string().min(1), label: z.string().min(1), answer: z.string().min(1) })),
}).superRefine((guide, context) => {
  const unique = new Set(guide.items.map((item) => item.sourceControlId ?? item.fieldId)).size === guide.items.length
  const counts = { READY: guide.readyCount, NEEDS_REVIEW: guide.needsReviewCount, MISSING: guide.missingCount, DIRECT_INPUT: guide.directInputCount }
  const valid = guide.totalCount === guide.items.length && Object.entries(counts).every(([status, value]) => guide.items.filter((item) => item.status === status).length === value)
    && guide.items.every((item) => (item.fieldId !== null || item.sourceControlId !== null)
      && item.copyable === (item.status === 'READY') && (item.status !== 'READY' || (item.fieldId !== null && item.answer !== null
        && item.inputMode !== 'MULTI_CHOICE' && (item.inputMode !== 'SINGLE_CHOICE' && item.inputMode !== 'DROPDOWN' || item.options.includes(item.answer)))))
    && guide.savedAnswers.length === guide.readyCount
    && new Set(guide.savedAnswers.map((item) => item.fieldId)).size === guide.savedAnswers.length
    && guide.savedAnswers.every((saved) => guide.items.some((item) => item.fieldId === saved.fieldId && item.label === saved.label && item.answer === saved.answer
      && item.status === 'READY' && item.copyable && (item.options.length === 0 || item.options.includes(saved.answer))))
  if (!unique || !valid) context.addIssue({ code: 'custom', message: '입력 안내와 저장 답변이 일치하지 않습니다.' })
})
