import { z } from 'zod'
import { conversationContextDtoSchema } from './SupportProgramConversationDto'

import type { SupportProgram } from '../../domain/entities/SupportProgram'

const isoLocalDateSchema = z.iso.date()
const sourceCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)
const officialSourceHostsByCode: Record<string, readonly string[]> = {
  BIZINFO: ['bizinfo.go.kr'],
  KSTARTUP: ['k-startup.go.kr'],
  MSIT: ['msit.go.kr'],
  CNTRADE_NOTICE: ['cntrade.chungnam.go.kr'],
}

export function isOfficialSupportProgramSourceUrl(sourceCode: string, value: string): boolean {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    const officialHosts = officialSourceHostsByCode[sourceCode]

    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username
      && !url.password
      && !url.port
      && officialHosts?.some((officialHost) => (
        hostname === officialHost || hostname.endsWith(`.${officialHost}`)
      )) === true
  } catch {
    return false
  }
}

const eligibilityAxisDtoSchema = z.object({
  status: z.enum(['MATCH', 'UNKNOWN']),
  explanation: z.string().refine((value) => value.trim().length > 0
    && Array.from(value).length <= 160 && !/\p{C}/u.test(value)),
  evidence: z.array(z.object({
    field: z.enum(['SUMMARY', 'TARGET_DESCRIPTION']),
    quote: z.string().refine((value) => value.trim().length > 0
      && Array.from(value).length <= 240 && !/\p{C}/u.test(value)),
  })).max(1),
}).superRefine((axis, context) => {
  if (axis.status === 'MATCH' && axis.evidence.length !== 1) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: '조건 확인에는 공식 본문 인용이 필요합니다.' })
  }
})

const eligibilityReviewDtoSchema = z.object({
  status: z.enum(['MATCH', 'REVIEW_REQUIRED']),
  basis: z.literal('OFFICIAL_API_TEXT'),
  target: eligibilityAxisDtoSchema,
  region: eligibilityAxisDtoSchema,
}).superRefine((review, context) => {
  const bothAxesMatch = review.target.status === 'MATCH' && review.region.status === 'MATCH'
  if ((review.status === 'MATCH') !== bothAxesMatch) {
    context.addIssue({ code: 'custom', path: ['status'], message: '전체 판정과 지원 대상·지역 판정이 일치해야 합니다.' })
  }
})

export const supportProgramDtoSchema = z.object({
  sourceCode: sourceCodeSchema,
  id: z.string().min(1),
  title: z.string().min(1),
  organization: z.string(),
  summary: z.string(),
  categories: z.array(z.string()),
  regions: z.array(z.string()),
  targetDescription: z.string(),
  applicationPeriod: z.string().min(1),
  applicationStartDate: isoLocalDateSchema.nullable(),
  applicationEndDate: isoLocalDateSchema.nullable(),
  status: z.enum(['OPEN', 'UPCOMING', 'CLOSED', 'UNKNOWN']),
  sourceName: z.string().min(1),
  sourceUrl: z.string().url(),
  matchedReasons: z.array(z.string()),
  recommendationScore: z.number().int().min(0).max(100).nullable(),
  eligibilityReview: eligibilityReviewDtoSchema.nullable().default(null),
}).superRefine((program, context) => {
  if (!isOfficialSupportProgramSourceUrl(program.sourceCode, program.sourceUrl)) {
    context.addIssue({
      code: 'custom',
      path: ['sourceUrl'],
      message: `${program.sourceCode} 제공처의 공식 http(s) URL이어야 합니다.`,
    })
  }
  if (!program.eligibilityReview) return
  for (const axisName of ['target', 'region'] as const) {
    program.eligibilityReview[axisName].evidence.forEach((evidence, index) => {
      const source = evidence.field === 'SUMMARY' ? program.summary : program.targetDescription
      if (!source.includes(evidence.quote)) {
        context.addIssue({
          code: 'custom',
          path: ['eligibilityReview', axisName, 'evidence', index, 'quote'],
          message: '자격 판정 인용은 지정한 공고 본문과 정확히 일치해야 합니다.',
        })
      }
    })
  }
})

export const supportProgramSearchResponseDtoSchema = z.object({
  query: z.string(),
  programs: z.array(supportProgramDtoSchema).max(5),
  totalCount: z.number().int().min(0).max(5),
  resultToken: z.uuid().refine((value) => value === value.toLowerCase()).nullable(),
  expiresAt: z.iso.datetime().nullable(),
}).superRefine((response, context) => {
  const locked = response.resultToken !== null
  if (locked !== (response.expiresAt !== null)
    || (locked ? response.programs.length !== 2 || response.totalCount <= 2
      : response.totalCount !== response.programs.length)) {
    context.addIssue({ code: 'custom', message: '공개 공고 수와 전체 추천 수, 결과 보관 정보가 일치해야 합니다.' })
  }
  const identities = new Set<string>()
  response.programs.forEach((program, index) => {
    const identity = JSON.stringify([program.sourceCode, program.id])
    if (identities.has(identity)) {
      context.addIssue({ code: 'custom', path: ['programs', index, 'id'], message: '같은 제공처의 공고가 검색 결과에 중복될 수 없습니다.' })
    }
    identities.add(identity)
  })
})

export const restoredSupportProgramSearchResponseDtoSchema = supportProgramSearchResponseDtoSchema.safeExtend({
  context: conversationContextDtoSchema,
}).superRefine((response, context) => {
  if (response.resultToken !== null || response.expiresAt !== null
    || (response.context.query ?? '') !== response.query) {
    context.addIssue({ code: 'custom', message: '복원 결과는 전체 공고와 동일한 검색 조건을 반환해야 합니다.' })
  }
})

export type RestoredSupportProgramSearchResponseDto = z.infer<typeof restoredSupportProgramSearchResponseDtoSchema>

export type SupportProgramDto = z.infer<typeof supportProgramDtoSchema>
export type SupportProgramSearchResponseDto = z.infer<
  typeof supportProgramSearchResponseDtoSchema
>

/** HTTP DTO와 Domain 객체가 우연히 같은 모양이어도 경계를 명시적으로 유지합니다. */
export function toSupportProgram(dto: SupportProgramDto): SupportProgram {
  return {
    sourceCode: dto.sourceCode,
    id: dto.id,
    title: dto.title,
    organization: dto.organization,
    summary: dto.summary,
    categories: [...dto.categories],
    regions: [...dto.regions],
    targetDescription: dto.targetDescription,
    applicationPeriod: dto.applicationPeriod,
    applicationStartDate: dto.applicationStartDate,
    applicationEndDate: dto.applicationEndDate,
    status: dto.status,
    sourceName: dto.sourceName,
    sourceUrl: dto.sourceUrl,
    matchedReasons: [...dto.matchedReasons],
    recommendationScore: dto.recommendationScore,
    eligibilityReview: dto.eligibilityReview ? {
      status: dto.eligibilityReview.status,
      basis: dto.eligibilityReview.basis,
      target: {
        ...dto.eligibilityReview.target,
        evidence: dto.eligibilityReview.target.evidence.map((evidence) => ({ ...evidence })),
      },
      region: {
        ...dto.eligibilityReview.region,
        evidence: dto.eligibilityReview.region.evidence.map((evidence) => ({ ...evidence })),
      },
    } : null,
  }
}
