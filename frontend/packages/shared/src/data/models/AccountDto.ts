import { z } from 'zod'

import type { Account } from '../../domain/entities/Account'
import type { AccountDeletionPreview } from '../../domain/entities/AccountDeletionPreview'
import type { AuthSession } from '../../domain/entities/AuthSession'

export const accountRoleSchema = z.enum(['USER', 'ADMIN'])
export const accountTierSchema = z.enum(['MEMBER', 'COMPANY', 'ADMIN'])
export const accountTypeSchema = z.enum(['INDIVIDUAL', 'BUSINESS'])

export const businessStatusCodeSchema = z.enum(['01', '02', '03'])

export const accountCompanySummaryDtoSchema = z.object({
  companyName: z.string().trim().min(1),
  businessNumber: z.string().regex(/^\d{10}$/),
  // 이 값을 내려 주기 전의 서버는 계속사업자만 등록했으므로 없으면 계속으로 봅니다.
  businessStatusCode: businessStatusCodeSchema.optional().transform((value) => value ?? '01'),
})

export const accountDtoSchema = z.object({
  email: z.string().trim().min(1).max(320),
  role: accountRoleSchema,
  tier: accountTierSchema,
  emailVerified: z.boolean(),
  company: accountCompanySummaryDtoSchema.nullable().optional().transform((value) => value ?? null),
  // 이 값을 내려 주기 전의 서버는 비밀번호로만 가입할 수 있었으므로 없으면 참으로 봅니다.
  hasPassword: z.boolean().optional().transform((value) => value ?? true),
  accountType: accountTypeSchema.nullable().optional().transform((value) => value ?? null),
  // 이 값을 내려 주기 전의 서버에는 환영 화면이 없었으므로 없으면 마친 것으로 봅니다.
  onboarded: z.boolean().optional().transform((value) => value ?? true),
})

/** 세션 토큰은 HttpOnly 쿠키로만 오므로 본문에는 만료 시각과 계정만 있습니다. */
export const authSessionResponseDtoSchema = z.object({
  expiresAt: z.string().datetime({ offset: true }),
  account: accountDtoSchema,
})

export const currentAccountResponseDtoSchema = z.object({
  account: accountDtoSchema,
})

export const accountDeletionPreviewDtoSchema = z.object({
  hasCompany: z.boolean(),
  openRecruitmentCount: z.number().int().nonnegative(),
  receivedPendingProposalCount: z.number().int().nonnegative(),
  sentPendingProposalCount: z.number().int().nonnegative(),
})

export type AccountDto = z.infer<typeof accountDtoSchema>
export type AuthSessionResponseDto = z.infer<typeof authSessionResponseDtoSchema>

/** DTO를 복사해 View가 외부 HTTP 응답 객체를 직접 보유하지 않게 합니다. */
export function toAccount(dto: AccountDto): Account {
  return {
    email: dto.email,
    role: dto.role,
    tier: dto.tier,
    emailVerified: dto.emailVerified,
    company: dto.company === null
      ? null
      : { companyName: dto.company.companyName, businessNumber: dto.company.businessNumber, businessStatusCode: dto.company.businessStatusCode },
    hasPassword: dto.hasPassword,
    accountType: dto.accountType,
    onboarded: dto.onboarded,
  }
}

export function toAccountDeletionPreview(dto: z.infer<typeof accountDeletionPreviewDtoSchema>): AccountDeletionPreview {
  return {
    hasCompany: dto.hasCompany,
    openRecruitmentCount: dto.openRecruitmentCount,
    receivedPendingProposalCount: dto.receivedPendingProposalCount,
    sentPendingProposalCount: dto.sentPendingProposalCount,
  }
}

export function toAuthSession(dto: AuthSessionResponseDto): AuthSession {
  return {
    expiresAt: dto.expiresAt,
    account: toAccount(dto.account),
  }
}
