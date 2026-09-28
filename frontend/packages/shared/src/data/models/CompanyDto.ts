import { z } from 'zod'

import type { BusinessLookup, Company } from '../../domain/entities/Company'
import type { CompanyPartnerProfile } from '../../domain/entities/CompanyPartnerProfile'

const optionalText = z.string().nullable().optional().transform((value) => value ?? null)

export const businessStatusCodeSchema = z.enum(['01', '02', '03'])

export const businessLookupDtoSchema = z.object({
  businessNumber: z.string().regex(/^\d{10}$/),
  companyName: z.string().trim().min(1),
  businessStatus: z.string(),
  isActive: z.boolean(),
  // 상태 코드·등록 가능 여부를 내려 주기 전의 서버는 계속사업자만 등록했으므로 isActive로 보충합니다.
  businessStatusCode: businessStatusCodeSchema.optional(),
  canRegister: z.boolean().optional(),
})

export const companyDtoSchema = z.object({
  businessNumber: z.string().regex(/^\d{10}$/),
  companyName: z.string().trim().min(1),
  businessStatus: z.string(),
  businessStatusCode: businessStatusCodeSchema.optional().transform((value) => value ?? '01'),
  region: z.string().min(1),
  industry: z.string().min(1),
  foundedYear: z.number().int(),
  homepageUrl: optionalText,
  businessVerifiedAt: z.string(),
  updatedAt: z.string(),
})

export const companyPartnerProfileDtoSchema = z.object({
  isSet: z.boolean(),
  roles: z.array(z.enum(['LEAD', 'PARTICIPANT', 'DEMAND'])),
  interestAreas: z.array(z.string()),
  introduction: z.string(),
  capabilities: z.array(z.string()),
  updatedAt: optionalText,
})

export type CompanyPartnerProfileDto = z.infer<typeof companyPartnerProfileDtoSchema>

export function toCompanyPartnerProfile(dto: CompanyPartnerProfileDto): CompanyPartnerProfile {
  return {
    isSet: dto.isSet,
    roles: [...dto.roles],
    interestAreas: [...dto.interestAreas],
    introduction: dto.introduction,
    capabilities: [...dto.capabilities],
    updatedAt: dto.updatedAt,
  }
}

export type BusinessLookupDto = z.infer<typeof businessLookupDtoSchema>
export type CompanyDto = z.infer<typeof companyDtoSchema>

/** DTO를 복사해 View가 외부 HTTP 응답 객체를 직접 보유하지 않게 합니다. */
export function toBusinessLookup(dto: BusinessLookupDto): BusinessLookup {
  return {
    businessNumber: dto.businessNumber,
    companyName: dto.companyName,
    businessStatus: dto.businessStatus,
    businessStatusCode: dto.businessStatusCode ?? (dto.isActive ? '01' : '03'),
    isActive: dto.isActive,
    canRegister: dto.canRegister ?? dto.isActive,
  }
}

export function toCompany(dto: CompanyDto): Company {
  return {
    businessNumber: dto.businessNumber,
    companyName: dto.companyName,
    businessStatus: dto.businessStatus,
    businessStatusCode: dto.businessStatusCode,
    region: dto.region,
    industry: dto.industry,
    foundedYear: dto.foundedYear,
    homepageUrl: dto.homepageUrl,
    businessVerifiedAt: dto.businessVerifiedAt,
    updatedAt: dto.updatedAt,
  }
}
