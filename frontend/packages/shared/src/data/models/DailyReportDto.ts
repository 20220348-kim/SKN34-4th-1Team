import { z } from 'zod'
import { isOfficialSupportProgramSourceUrl } from './SupportProgramDto'

export const dailyReportSettingsSchema = z.object({
  supportPurpose: z.string().max(100), enabled: z.boolean(), emailConfirmed: z.boolean(),
  emailDeliveryAvailable: z.boolean(), schedulerEnabled: z.boolean(), sendHour: z.number().int().min(0).max(23),
})

const itemSchema = z.object({
  sourceCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), sourceProgramId: z.string().min(1),
  title: z.string().min(1), sourceUrl: z.string().url(), applicationPeriod: z.string(),
  relevanceScore: z.number().int().min(0).max(100).nullable(), matchedReasons: z.array(z.string()),
  eligibilityStatus: z.enum(['MATCH', 'REVIEW_REQUIRED', 'UNKNOWN']), eligibilityNote: z.string(),
  evidenceStatus: z.enum(['ANSWERED', 'INSUFFICIENT_EVIDENCE', 'UNSUPPORTED', 'FAILED']),
  evidenceAnswer: z.string().nullable(), citations: z.array(z.object({ excerpt: z.string().min(1), sourceUrl: z.string().url() })),
}).superRefine((item, context) => {
  if (!isOfficialSupportProgramSourceUrl(item.sourceCode, item.sourceUrl)
    || item.citations.some((citation) => !isOfficialSupportProgramSourceUrl(item.sourceCode, citation.sourceUrl))) {
    context.addIssue({ code: 'custom', message: '리포트의 공고와 인용은 해당 제공처의 공식 URL이어야 합니다.' })
  }
  if (item.evidenceStatus === 'ANSWERED' && (!item.evidenceAnswer?.trim() || item.citations.length === 0)) {
    context.addIssue({ code: 'custom', message: '답변 완료에는 원문 근거가 필요합니다.' })
  }
})

export const dailyReportSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), reportDate: z.iso.date(),
  status: z.enum(['GENERATING', 'READY', 'FAILED']),
  deliveryStatus: z.enum(['NOT_REQUESTED', 'SENDING', 'SENT', 'UNKNOWN', 'SKIPPED']),
  companyName: z.string(), region: z.string(), industry: z.string(), supportPurpose: z.string(),
  generatedAt: z.string().datetime({ offset: true }).nullable(), programs: z.array(itemSchema).max(3),
  warnings: z.array(z.string()), errorMessage: z.string().nullable(),
}).superRefine((report, context) => {
  const identities = report.programs.map((item) => JSON.stringify([item.sourceCode, item.sourceProgramId]))
  if (new Set(identities).size !== identities.length) context.addIssue({ code: 'custom', message: '같은 공고가 중복되었습니다.' })
  if (report.status !== 'READY' && report.programs.length !== 0) context.addIssue({ code: 'custom', message: '완료되지 않은 리포트에 추천 결과가 있습니다.' })
})

export const dailyReportResponseSchema = z.object({ report: dailyReportSchema.nullable() })
export const dailyReportProblemSchema = z.object({ code: z.string() })
