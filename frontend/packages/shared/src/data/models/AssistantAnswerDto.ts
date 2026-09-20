import { z } from 'zod'

import type { AssistantAnswer } from '../../domain/entities/AssistantAnswer'

export const assistantIntentSchema = z.enum([
  'PRODUCT_HELP', 'ACCOUNT_STATE', 'SEARCH', 'PROGRAM_QUESTION', 'OUT_OF_SCOPE', 'UNCLEAR', 'PARTNER_MATCH', 'SAVED_PROGRAMS_QUESTION',
])
export const assistantAccountTopicSchema = z.enum(['SAVED_PROGRAMS', 'RECEIVED_PROPOSALS', 'COMPANY_PROFILE'])
export const assistantCardKindSchema = z.enum(['RECRUITMENT', 'PROGRAM'])

/** 이동 버튼의 경로는 Core가 `/app` 아래 내부 경로만 내려주지만, 화면은 한 번 더 절대 경로인지 확인합니다. */
export const assistantNavigationDtoSchema = z.object({
  label: z.string().trim().min(1).max(160),
  to: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/),
})

/** 도구 에이전트가 고른 항목(모집글·공고)입니다. 경로는 `/app` 아래 내부 경로에 질의만 허용합니다. */
export const assistantCardDtoSchema = z.object({
  kind: assistantCardKindSchema,
  id: z.string().regex(/^[A-Za-z0-9_:.-]{1,80}$/),
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().min(1).max(160).nullable(),
  reason: z.string().trim().min(1).max(200),
  /** 관심 공고 묶음 질문에서만: 공고 원문에서 그대로 옮긴 근거 구절입니다. */
  quote: z.string().trim().min(1).max(300).nullable(),
  to: z.string().regex(/^\/app\/[A-Za-z0-9/_-]+(\?[A-Za-z0-9_=&%.:+-]*)?$/),
})

export const assistantAnswerDtoSchema = z.object({
  intent: assistantIntentSchema,
  answer: z.string().trim().min(1).max(600).nullable(),
  citations: z.array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)).max(3),
  clarificationQuestion: z.string().trim().min(1).max(160).nullable(),
  searchQuery: z.string().trim().min(1).max(500).nullable(),
  accountTopic: assistantAccountTopicSchema.nullable(),
  navigation: assistantNavigationDtoSchema.nullable(),
  cards: z.array(assistantCardDtoSchema).max(5),
})

export type AssistantAnswerDto = z.infer<typeof assistantAnswerDtoSchema>

export function toAssistantAnswer(dto: AssistantAnswerDto): AssistantAnswer {
  return {
    intent: dto.intent,
    answer: dto.answer,
    citations: [...dto.citations],
    clarificationQuestion: dto.clarificationQuestion,
    searchQuery: dto.searchQuery,
    accountTopic: dto.accountTopic,
    navigation: dto.navigation === null ? null : { label: dto.navigation.label, to: dto.navigation.to },
    cards: dto.cards.map((card) => ({ kind: card.kind, id: card.id, title: card.title, subtitle: card.subtitle, reason: card.reason, quote: card.quote, to: card.to })),
  }
}
