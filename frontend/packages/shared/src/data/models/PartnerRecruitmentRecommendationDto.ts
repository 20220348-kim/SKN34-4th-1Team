import { z } from 'zod'

import type { PartnerRecruitmentRecommendations } from '../../domain/entities/PartnerRecruitmentRecommendation'
import { partnerRecruitmentSummaryDtoSchema, toPartnerRecruitmentSummary } from './PartnerRecruitmentDto'

const roleSchema = z.enum(['LEAD', 'PARTICIPANT', 'DEMAND'])

export const partnerRecruitmentRecommendationsDtoSchema = z.object({
  items: z.array(z.object({
    recruitment: partnerRecruitmentSummaryDtoSchema,
    reasons: z.array(z.object({
      type: z.enum(['MY_PROGRAM', 'KEYWORD', 'CAPABILITY', 'SAME_REGION', 'ROLE']),
      values: z.array(z.string().min(1)).max(10),
      programSource: z.enum(['SAVED', 'PREPARATION']).nullable(),
    })).max(5),
    cautions: z.array(z.object({ type: z.enum(['OTHER_REGION', 'COMPANY_AGE']), value: z.string().min(1) })).max(2),
  })).max(20),
  total: z.number().int().min(0),
  basis: z.object({
    hasCompany: z.boolean(),
    profileSet: z.boolean(),
    roles: z.array(roleSchema).max(3),
    capabilityCount: z.number().int().min(0),
    myProgramCount: z.number().int().min(0),
    region: z.string().min(1).nullable(),
  }),
  relax: z.array(z.object({ type: z.enum(['ROLE', 'REGION', 'PROGRAM']), count: z.number().int().min(0) })).max(3),
  suggestedProgram: z.object({
    sourceCode: z.string().min(1),
    sourceProgramId: z.string().min(1),
    title: z.string(),
  }).nullable(),
})

export type PartnerRecruitmentRecommendationsDto = z.infer<typeof partnerRecruitmentRecommendationsDtoSchema>

export function toPartnerRecruitmentRecommendations(dto: PartnerRecruitmentRecommendationsDto): PartnerRecruitmentRecommendations {
  return {
    items: dto.items.map((item) => ({
      recruitment: toPartnerRecruitmentSummary(item.recruitment),
      reasons: item.reasons.map((reason) => ({ ...reason, values: [...reason.values] })),
      cautions: item.cautions.map((caution) => ({ ...caution })),
    })),
    total: dto.total,
    basis: { ...dto.basis, roles: [...dto.basis.roles] },
    relax: dto.relax.map((relax) => ({ ...relax })),
    suggestedProgram: dto.suggestedProgram === null ? null : { ...dto.suggestedProgram },
  }
}
