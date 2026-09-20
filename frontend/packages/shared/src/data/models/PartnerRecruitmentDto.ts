import { z } from 'zod'

import type { PartnerRecruitment, PartnerRecruitmentSummary } from '../../domain/entities/PartnerRecruitment'
import type { PartnerRecruitmentPage } from '../../domain/entities/PartnerRecruitmentQuery'

const roleSchema = z.enum(['LEAD', 'PARTICIPANT', 'DEMAND'])
const isoDateSchema = z.iso.date()
const nullableDate = isoDateSchema.nullable().optional().transform((value) => value ?? null)

const companyDtoSchema = z.object({
  companyName: z.string().trim().min(1),
  region: z.string().min(1),
  industry: z.string().min(1),
  foundedYear: z.number().int(),
  isEmailVerified: z.boolean(),
  isBusinessVerified: z.boolean(),
})

const summaryFields = {
  id: z.number().int().positive(),
  title: z.string().min(1),
  seekingRole: roleSchema,
  seekingCount: z.number().int().min(1).max(9),
  region: z.string().min(1),
  capabilities: z.array(z.string().min(1)).max(10),
  recruitmentDeadline: isoDateSchema,
  status: z.enum(['OPEN', 'CLOSED']),
  isMine: z.boolean(),
  proposalCount: z.number().int().min(0),
  company: companyDtoSchema,
  createdAt: z.string(),
}

export const partnerRecruitmentSummaryDtoSchema = z.object({
  ...summaryFields,
  program: z.object({
    title: z.string().min(1),
    organization: z.string(),
    applicationEndDate: nullableDate,
  }),
})

export const partnerRecruitmentDtoSchema = z.object({
  ...summaryFields,
  body: z.string().min(1),
  myProposal: z.object({
    id: z.number().int().positive(),
    status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED']),
  }).nullable().optional().transform((value) => value ?? null),
  ownRole: roleSchema,
  minimumCompanyAgeYears: z.number().int().min(1).max(50).nullable().optional().transform((value) => value ?? null),
  program: z.object({
    sourceCode: z.string().min(1),
    sourceProgramId: z.string().min(1),
    title: z.string().min(1),
    organization: z.string(),
    summary: z.string(),
    targetDescription: z.string(),
    applicationPeriod: z.string(),
    applicationEndDate: nullableDate,
    sourceUrl: z.string(),
  }),
  updatedAt: z.string(),
})

export const partnerRecruitmentListDtoSchema = z.object({
  recruitments: z.array(partnerRecruitmentSummaryDtoSchema).max(50),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(50),
  totalPages: z.number().int().min(0),
})

export type PartnerRecruitmentSummaryDto = z.infer<typeof partnerRecruitmentSummaryDtoSchema>
export type PartnerRecruitmentDto = z.infer<typeof partnerRecruitmentDtoSchema>
export type PartnerRecruitmentListDto = z.infer<typeof partnerRecruitmentListDtoSchema>

/** DTO를 복사해 View가 외부 HTTP 응답 객체를 직접 보유하지 않게 합니다. */
export function toPartnerRecruitmentSummary(dto: PartnerRecruitmentSummaryDto): PartnerRecruitmentSummary {
  return {
    id: dto.id,
    title: dto.title,
    seekingRole: dto.seekingRole,
    seekingCount: dto.seekingCount,
    region: dto.region,
    capabilities: [...dto.capabilities],
    recruitmentDeadline: dto.recruitmentDeadline,
    status: dto.status,
    isMine: dto.isMine,
    proposalCount: dto.proposalCount,
    company: { ...dto.company },
    program: { ...dto.program },
    createdAt: dto.createdAt,
  }
}

export function toPartnerRecruitment(dto: PartnerRecruitmentDto): PartnerRecruitment {
  return {
    id: dto.id,
    title: dto.title,
    body: dto.body,
    myProposal: dto.myProposal === null ? null : { ...dto.myProposal },
    ownRole: dto.ownRole,
    seekingRole: dto.seekingRole,
    seekingCount: dto.seekingCount,
    region: dto.region,
    minimumCompanyAgeYears: dto.minimumCompanyAgeYears,
    capabilities: [...dto.capabilities],
    recruitmentDeadline: dto.recruitmentDeadline,
    status: dto.status,
    isMine: dto.isMine,
    proposalCount: dto.proposalCount,
    company: { ...dto.company },
    program: { ...dto.program },
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  }
}

export function toPartnerRecruitmentPage(dto: PartnerRecruitmentListDto): PartnerRecruitmentPage<PartnerRecruitmentSummary> {
  return {
    recruitments: dto.recruitments.map(toPartnerRecruitmentSummary),
    total: dto.total,
    page: dto.page,
    pageSize: dto.pageSize,
    totalPages: dto.totalPages,
  }
}
