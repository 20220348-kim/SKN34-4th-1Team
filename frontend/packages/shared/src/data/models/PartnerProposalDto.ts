import { z } from 'zod'

import type { PartnerProposal, PartnerProposalBoxPage } from '../../domain/entities/PartnerProposal'

const nullableText = z.string().nullable().optional().transform((value) => value ?? null)

export const partnerProposalDtoSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED']),
  message: z.string().min(1),
  shareProfile: z.boolean(),
  isSent: z.boolean(),
  recruitment: z.object({
    id: z.number().int().positive(),
    title: z.string().min(1),
    status: z.enum(['OPEN', 'CLOSED']),
    recruitmentDeadline: z.iso.date(),
  }),
  counterpart: z.object({
    companyName: z.string().trim().min(1),
    isEmailVerified: z.boolean(),
    isBusinessVerified: z.boolean(),
    profile: z.object({
      region: z.string().min(1),
      industry: z.string().min(1),
      foundedYear: z.number().int(),
      homepageUrl: nullableText,
    }).nullable().optional().transform((value) => value ?? null),
    contact: z.object({
      email: z.string().min(1),
      businessNumber: z.string().regex(/^\d{10}$/),
    }).nullable().optional().transform((value) => value ?? null),
  }),
  createdAt: z.string(),
  expiresAt: z.string(),
  respondedAt: nullableText,
})

export const partnerProposalBoxDtoSchema = z.object({
  box: z.enum(['received', 'sent']),
  proposals: z.array(partnerProposalDtoSchema).max(200),
  pendingCount: z.number().int().min(0),
})

export type PartnerProposalDto = z.infer<typeof partnerProposalDtoSchema>
export type PartnerProposalBoxDto = z.infer<typeof partnerProposalBoxDtoSchema>

/** DTO를 복사해 View가 외부 HTTP 응답 객체를 직접 보유하지 않게 합니다. */
export function toPartnerProposal(dto: PartnerProposalDto): PartnerProposal {
  return {
    id: dto.id,
    status: dto.status,
    message: dto.message,
    shareProfile: dto.shareProfile,
    isSent: dto.isSent,
    recruitment: { ...dto.recruitment },
    counterpart: {
      companyName: dto.counterpart.companyName,
      isEmailVerified: dto.counterpart.isEmailVerified,
      isBusinessVerified: dto.counterpart.isBusinessVerified,
      profile: dto.counterpart.profile === null ? null : { ...dto.counterpart.profile },
      contact: dto.counterpart.contact === null ? null : { ...dto.counterpart.contact },
    },
    createdAt: dto.createdAt,
    expiresAt: dto.expiresAt,
    respondedAt: dto.respondedAt,
  }
}

export function toPartnerProposalBoxPage(dto: PartnerProposalBoxDto): PartnerProposalBoxPage {
  return { box: dto.box, proposals: dto.proposals.map(toPartnerProposal), pendingCount: dto.pendingCount }
}
