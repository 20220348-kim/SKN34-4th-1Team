import { z } from 'zod'

import type {
  AdminAccountDetail,
  AdminAccountPage,
  AdminAccountStats,
  AdminAccountSummary,
} from '../../domain/entities/AdminAccount'
import { accountRoleSchema, accountTierSchema } from './AccountDto'

const countSchema = z.number().int().nonnegative()
const dateTimeSchema = z.string().min(1)
const businessNumberSchema = z.string().regex(/^\d{10}$/)

export const adminAccountSummaryDtoSchema = z.object({
  id: z.number().int().positive(),
  email: z.string().min(1),
  role: accountRoleSchema,
  tier: accountTierSchema,
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  emailVerified: z.boolean(),
  hasPassword: z.boolean(),
  loginMethods: z.array(z.enum(['EMAIL', 'KAKAO', 'GOOGLE'])),
  company: z.object({ companyName: z.string().min(1), businessNumber: businessNumberSchema }).nullable(),
  createdAt: dateTimeSchema,
  lastLoginAt: dateTimeSchema.nullable(),
  suspendedAt: dateTimeSchema.nullable(),
})

export const adminAccountListDtoSchema = z.object({
  accounts: z.array(adminAccountSummaryDtoSchema),
  total: countSchema,
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalPages: countSchema,
})

export const adminAccountStatsDtoSchema = z.object({
  total: countSchema,
  companyRegistered: countSchema,
  socialLinked: countSchema,
  suspended: countSchema,
  admins: countSchema,
  joinedRecently: countSchema,
  recentJoinDays: z.number().int().positive(),
})

export const adminAccountDetailDtoSchema = z.object({
  account: adminAccountSummaryDtoSchema,
  company: z.object({
    companyName: z.string().min(1),
    businessNumber: businessNumberSchema,
    region: z.string(),
    industry: z.string(),
    foundedYear: z.number().int(),
  }).nullable(),
  activity: z.object({
    recruitmentCount: countSchema,
    openRecruitmentCount: countSchema,
    sentProposalCount: countSchema,
    activeSessionCount: countSchema,
  }),
  actions: z.array(z.object({
    id: z.number().int().positive(),
    action: z.enum(['SUSPEND', 'UNSUSPEND', 'SESSIONS_REVOKE']),
    reason: z.string().min(1),
    adminEmail: z.string().min(1),
    createdAt: dateTimeSchema,
  })),
  isSelf: z.boolean(),
})

export type AdminAccountSummaryDto = z.infer<typeof adminAccountSummaryDtoSchema>
export type AdminAccountListDto = z.infer<typeof adminAccountListDtoSchema>
export type AdminAccountStatsDto = z.infer<typeof adminAccountStatsDtoSchema>
export type AdminAccountDetailDto = z.infer<typeof adminAccountDetailDtoSchema>

/** DTO를 복사해 View가 외부 HTTP 응답 객체를 직접 보유하지 않게 합니다. */
export function toAdminAccountSummary(dto: AdminAccountSummaryDto): AdminAccountSummary {
  return {
    id: dto.id,
    email: dto.email,
    role: dto.role,
    tier: dto.tier,
    status: dto.status,
    emailVerified: dto.emailVerified,
    hasPassword: dto.hasPassword,
    loginMethods: [...dto.loginMethods],
    company: dto.company === null ? null : { companyName: dto.company.companyName, businessNumber: dto.company.businessNumber },
    createdAt: dto.createdAt,
    lastLoginAt: dto.lastLoginAt,
    suspendedAt: dto.suspendedAt,
  }
}

export function toAdminAccountPage(dto: AdminAccountListDto): AdminAccountPage {
  return {
    accounts: dto.accounts.map(toAdminAccountSummary),
    total: dto.total,
    page: dto.page,
    pageSize: dto.pageSize,
    totalPages: dto.totalPages,
  }
}

export function toAdminAccountStats(dto: AdminAccountStatsDto): AdminAccountStats {
  return { ...dto }
}

export function toAdminAccountDetail(dto: AdminAccountDetailDto): AdminAccountDetail {
  return {
    account: toAdminAccountSummary(dto.account),
    company: dto.company === null ? null : { ...dto.company },
    activity: { ...dto.activity },
    actions: dto.actions.map((action) => ({ ...action })),
    isSelf: dto.isSelf,
  }
}
