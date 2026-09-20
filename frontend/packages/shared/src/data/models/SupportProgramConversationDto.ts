import { z } from 'zod'

import { conversationChangedFields, type SupportProgramInterpretation } from '../../domain/entities/SupportProgramConversation'

const querySchema = z.string().max(500).refine((value) => value.trim().length > 0
  && !/[^\P{C}\n\r\t]/u.test(value))
const conditionText = (maximum: number) => z.string().max(maximum)
  .refine((value) => value.trim().length > 0 && !/\p{C}/u.test(value)).nullable()
const establishedOnSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`)
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    && value >= '1900-01-01' && value <= today
}).nullable()

export const conversationContextDtoSchema = z.object({
  query: querySchema.nullable(),
  acceptingOnly: z.boolean(),
  companyConditions: z.object({
    region: conditionText(50),
    industry: conditionText(100),
    establishedOn: establishedOnSchema,
    foundedYear: z.number().int().min(1900).max(Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(new Date()))).nullish(),
    supportPurpose: conditionText(100),
  }),
})

export const supportProgramInterpretationDtoSchema = z.object({
  status: z.enum(['READY', 'CLARIFICATION_REQUIRED', 'ANSWERED']),
  proposedContext: conversationContextDtoSchema,
  clarificationQuestion: z.string().max(160)
    .refine((value) => value.trim().length > 0 && !/\p{C}/u.test(value)).nullable(),
  answer: z.string().max(1000).refine((value) => value.trim().length > 0
    && !/[^\P{C}\n\r\t]/u.test(value)).nullable().default(null),
  changedFields: z.array(z.enum(conversationChangedFields)).max(7),
}).superRefine((value, context) => {
  if (value.status === 'READY' && (!value.proposedContext.query || value.clarificationQuestion !== null)) {
    context.addIssue({ code: 'custom', message: 'READY에는 검색 의도가 필요하며 확인 질문은 없어야 합니다.' })
  }
  if (value.status === 'CLARIFICATION_REQUIRED' && value.clarificationQuestion === null) {
    context.addIssue({ code: 'custom', message: '정보가 부족하면 확인 질문이 필요합니다.' })
  }
  if (value.status === 'ANSWERED' && (value.answer === null || value.clarificationQuestion !== null)) {
    context.addIssue({ code: 'custom', message: 'ANSWERED에는 답변이 필요하며 확인 질문은 없어야 합니다.' })
  }
  if (value.status !== 'ANSWERED' && value.answer !== null) {
    context.addIssue({ code: 'custom', message: '조건 제안에는 답변을 함께 반환할 수 없습니다.' })
  }
  const orderedFields = conversationChangedFields.filter((field) => value.changedFields.includes(field))
  if (orderedFields.join(',') !== value.changedFields.join(',')) {
    context.addIssue({ code: 'custom', path: ['changedFields'], message: '변경 필드는 중복 없이 정해진 순서여야 합니다.' })
  }
})

export type SupportProgramInterpretationDto = z.infer<typeof supportProgramInterpretationDtoSchema>

export function toSupportProgramInterpretation(dto: SupportProgramInterpretationDto): SupportProgramInterpretation {
  return {
    ...dto,
    proposedContext: { ...dto.proposedContext, companyConditions: { ...dto.proposedContext.companyConditions } },
    changedFields: [...dto.changedFields],
  }
}
