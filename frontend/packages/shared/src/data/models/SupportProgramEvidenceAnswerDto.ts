import { z } from 'zod'

import type {
  SupportProgramEvidenceAnswer,
  SupportProgramEvidenceCitation,
} from '../../domain/entities/SupportProgramEvidenceAnswer'
import { isOfficialSupportProgramSourceUrl } from './SupportProgramDto'

const citationDtoSchema = z.object({
  excerpt: z.string().trim().min(1).max(1_500),
  sourceUrl: z.string().url(),
  chunkOrder: z.number().int().min(0),
})

export const supportProgramEvidenceAnswerDtoSchema = z.object({
  answer: z.string().trim().min(1).refine(
    (value) => Array.from(value).length <= 1_200,
    '답변은 유니코드 코드 포인트 기준 1,200자 이하여야 합니다.',
  ),
  answerStatus: z.enum(['ANSWERED', 'INSUFFICIENT_EVIDENCE']),
  citations: z.array(citationDtoSchema).max(5),
}).superRefine((answer, context) => {
  if (answer.answerStatus === 'ANSWERED' && answer.citations.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['citations'],
      message: 'ANSWERED 응답에는 하나 이상의 근거가 필요합니다.',
    })
  }
  if (answer.answerStatus === 'INSUFFICIENT_EVIDENCE' && answer.citations.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['citations'],
      message: 'INSUFFICIENT_EVIDENCE 응답에는 근거가 포함될 수 없습니다.',
    })
  }
})

export type SupportProgramEvidenceAnswerDto = z.infer<
  typeof supportProgramEvidenceAnswerDtoSchema
>

/** HTTP 응답의 근거 링크가 요청한 제공처의 공식 원문인지 검증합니다. */
export function parseSupportProgramEvidenceAnswerDto(
  payload: unknown,
  sourceCode: string,
): SupportProgramEvidenceAnswerDto {
  const answer = supportProgramEvidenceAnswerDtoSchema.parse(payload)
  for (const citation of answer.citations) {
    if (isOfficialSupportProgramSourceUrl(sourceCode, citation.sourceUrl)) continue

    throw new Error('Core API returned an evidence citation outside the official source URL.')
  }
  return answer
}

/** DTO 배열을 복사해 View가 외부 HTTP 응답 객체를 직접 보유하지 않게 합니다. */
export function toSupportProgramEvidenceAnswer(
  dto: SupportProgramEvidenceAnswerDto,
): SupportProgramEvidenceAnswer {
  return {
    answer: dto.answer,
    answerStatus: dto.answerStatus,
    citations: dto.citations.map(toSupportProgramEvidenceCitation),
  }
}

function toSupportProgramEvidenceCitation(
  dto: SupportProgramEvidenceAnswerDto['citations'][number],
): SupportProgramEvidenceCitation {
  return {
    excerpt: dto.excerpt,
    sourceUrl: dto.sourceUrl,
    chunkOrder: dto.chunkOrder,
  }
}
