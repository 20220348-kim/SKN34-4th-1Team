import { z } from 'zod'
import type { GovAgentResult } from '../../domain/entities/GovAgent'
import type { SupportProgramIdentity } from '../../domain/repositories/SupportProgramRepository'
import { supportProgramInterpretationDtoSchema } from './SupportProgramConversationDto'
import { parseSupportProgramEvidenceAnswerDto, supportProgramEvidenceAnswerDtoSchema } from './SupportProgramEvidenceAnswerDto'
import { isOfficialSupportProgramSourceUrl } from './SupportProgramDto'

const identitySchema = z.object({ sourceCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  sourceProgramId: z.string().min(1).refine((value) => Array.from(value).length <= 255 && value.trim() === value && !/\p{C}/u.test(value)) })
export const govAgentProgramSchema = identitySchema.extend({ title: z.string().min(1).max(1_000) })
export const govAgentApplicationSchema = z.object({ program: govAgentProgramSchema, message: z.string().min(1).max(1_000),
  preparationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() })
export const govAgentReviewSchema = z.object({ program: govAgentProgramSchema.nullable(), message: z.string().min(1).max(1_000),
  reviewId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() })
const partnerRegionNames = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
  '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'] as const
export const govAgentPartnerConditionsSchema = z.object({
  seekingRoles: z.array(z.enum(['LEAD', 'PARTICIPANT', 'DEMAND'])).max(3),
  regions: z.array(z.enum(partnerRegionNames)).max(partnerRegionNames.length),
  keywords: z.array(z.string().trim().min(1).max(30)).max(3),
  program: identitySchema.nullable(),
})
export const govAgentPartnersSchema = z.object({ message: z.string().min(1).max(1_000), conditions: govAgentPartnerConditionsSchema.optional() })
export const govAgentEvidenceSchema = z.object({ program: govAgentProgramSchema, answer: supportProgramEvidenceAnswerDtoSchema })
  .refine((value) => value.answer.citations.every((citation) => isOfficialSupportProgramSourceUrl(value.program.sourceCode, citation.sourceUrl)),
    '근거는 선택한 제공처의 공식 원문이어야 합니다.')

const resultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('SEARCH'), interpretation: supportProgramInterpretationDtoSchema,
    evidence: z.null().optional(), program: z.null().optional(), message: z.null().optional() }),
  z.object({ outcome: z.literal('EVIDENCE'), evidence: supportProgramEvidenceAnswerDtoSchema, program: identitySchema,
    interpretation: z.null().optional(), message: z.null().optional() }),
  z.object({ outcome: z.literal('APPLICATION'), program: identitySchema, message: z.string().min(1).max(1_000),
    interpretation: z.null().optional(), evidence: z.null().optional() }),
  z.object({ outcome: z.literal('COMBINATION_REVIEW'), program: identitySchema.nullable(), message: z.string().min(1).max(1_000),
    interpretation: z.null().optional(), evidence: z.null().optional() }),
  z.object({ outcome: z.literal('PARTNERS'), message: z.string().min(1).max(1_000),
    partnerConditions: govAgentPartnerConditionsSchema.nullable().optional()
      .transform((value) => value ?? { seekingRoles: [], regions: [], keywords: [], program: null }),
    interpretation: z.null().optional(), evidence: z.null().optional(), program: z.null().optional() }),
  z.object({ outcome: z.enum(['NEEDS_PROGRAM', 'UNSUPPORTED']), message: z.string().min(1).max(1_000),
    interpretation: z.null().optional(), evidence: z.null().optional(), program: z.null().optional() }),
])

export function parseGovAgentResult(payload: unknown, selectedProgram: SupportProgramIdentity | null): GovAgentResult {
  const result = resultSchema.parse(payload)
  if (result.outcome === 'EVIDENCE' || result.outcome === 'APPLICATION') {
    if (!selectedProgram || result.program.sourceCode !== selectedProgram.sourceCode
      || result.program.sourceProgramId !== selectedProgram.sourceProgramId) throw new Error('Gov agent program mismatch')
  }
  if (result.outcome === 'COMBINATION_REVIEW' && (result.program?.sourceCode !== selectedProgram?.sourceCode
    || result.program?.sourceProgramId !== selectedProgram?.sourceProgramId)) throw new Error('Gov agent program mismatch')
  // "이 공고"로 좁힌 조건은 사용자가 고른 공고여야 합니다. 서버가 다른 공고를 돌려주면 받지 않습니다.
  if (result.outcome === 'PARTNERS' && result.partnerConditions.program && (!selectedProgram
    || result.partnerConditions.program.sourceCode !== selectedProgram.sourceCode
    || result.partnerConditions.program.sourceProgramId !== selectedProgram.sourceProgramId)) throw new Error('Gov agent program mismatch')
  if (result.outcome === 'EVIDENCE') {
    return { ...result, evidence: parseSupportProgramEvidenceAnswerDto(result.evidence, result.program.sourceCode) }
  }
  return result
}
