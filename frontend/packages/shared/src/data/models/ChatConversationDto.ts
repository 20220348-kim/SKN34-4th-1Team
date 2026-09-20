import { z } from 'zod'
import { conversationContextDtoSchema, supportProgramInterpretationDtoSchema } from './SupportProgramConversationDto'
import { supportProgramDtoSchema } from './SupportProgramDto'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const conditions = z.object({ region: z.string().max(50).optional(), industry: z.string().max(100).optional(),
  establishedOn: z.iso.date().optional(), foundedYear: z.number().int().min(1900).max(9999).optional(), supportPurpose: z.string().max(100).optional() })
const options = z.object({ acceptingOnly: z.boolean(), companyConditions: conditions.optional() })
const clarification = z.object({ question: z.string().max(160), draftContext: conversationContextDtoSchema })
const lastSearch = z.object({ context: conversationContextDtoSchema, resultCount: z.number().int().min(0).max(5) })
const request = z.object({ message: z.string().max(500), context: conversationContextDtoSchema,
  pendingClarification: clarification.nullable().optional(), pendingProposal: conversationContextDtoSchema.nullable().optional(),
  lastSearch: lastSearch.nullable().optional() })

export const chatConversationSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  companyDefaultsInitialized: z.boolean().optional(),
  messages: z.array(z.object({
    id: z.string().min(1).max(128), role: z.enum(['assistant', 'user']), text: z.string().max(10_000),
    failure: z.enum(['search', 'interpretation']).optional(), programs: z.array(supportProgramDtoSchema).max(5).optional(),
    totalCount: z.number().int().min(0).max(5).optional(), resultToken: z.uuid().nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional(), searchOptions: options.optional(), searchQuery: z.string().max(500).optional(),
  })).min(1).max(200),
  searchOptions: options,
  conversationQuery: z.string().max(500).nullable(),
  confirmedSearch: options.extend({ query: z.string().max(500) }).nullable(),
  lastSearch: lastSearch.nullable(), pendingProposal: conversationContextDtoSchema.nullable(), pendingClarification: clarification.nullable(),
  searchStatus: z.enum(['idle', 'failed']), searchError: z.string().nullable(),
  interpretation: z.object({ status: z.enum(['idle', 'ready', 'clarification', 'failed']), requestId: z.string().optional(),
    messageId: z.string().optional(), request: request.optional(), result: supportProgramInterpretationDtoSchema.optional(), error: z.string().optional() }),
}).superRefine((value, context) => {
  if (!value.messages.some((message) => message.role === 'user') || new Set(value.messages.map((message) => message.id)).size !== value.messages.length) {
    context.addIssue({ code: 'custom', message: '대화에는 사용자 질문과 중복되지 않는 메시지 ID가 필요합니다.' })
  }
  const interpretation = value.interpretation
  if (interpretation.status === 'ready' && (!interpretation.requestId || interpretation.result?.status !== 'READY')) {
    context.addIssue({ code: 'custom', message: '확인할 조건 제안이 올바르지 않습니다.' })
  }
})
export const chatConversationSummarySchema = z.object({ id, title: z.string().min(1).refine((value) => Array.from(value).length <= 80),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), updatedAt: z.iso.datetime({ local: true }) })
export const chatConversationPageSchema = z.object({ items: z.array(chatConversationSummarySchema).max(30),
  nextCursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() })
export const chatConversationDetailSchema = z.object({ conversation: chatConversationSummarySchema, snapshot: chatConversationSnapshotSchema })
  .refine((value) => value.snapshot.messages.find((message) => message.role === 'user')?.id === value.conversation.id)
