import { businessLookupDtoSchema, companyDtoSchema, companyPartnerProfileDtoSchema, toBusinessLookup, toCompany, toCompanyPartnerProfile } from '@govbiz/shared/data/models/CompanyDto'
import type { BusinessLookup, Company, CompanyProfileInput } from '@govbiz/shared/domain/entities/Company'
import type { CompanyPartnerProfile, CompanyPartnerProfileInput } from '@govbiz/shared/domain/entities/CompanyPartnerProfile'
import { UpdateCompanyPartnerProfileUseCase } from '@govbiz/shared/domain/usecases/CompanyPartnerProfileUseCases'
import { apiRequest, ApiError } from './client'

const companyPath = '/api/v1/me/company'

export async function getCompany(token: string, signal?: AbortSignal): Promise<Company> {
  return toCompany(companyDtoSchema.parse(await apiRequest(companyPath, { accessToken: token, signal })))
}

export async function lookupCompanyBusiness(token: string, businessNumber: string, signal?: AbortSignal): Promise<BusinessLookup> {
  const query = new URLSearchParams({ businessNumber })
  return toBusinessLookup(businessLookupDtoSchema.parse(await apiRequest(`${companyPath}/lookup?${query}`, { accessToken: token, signal })))
}

export async function saveCompanyProfile(token: string, input: CompanyProfileInput, businessNumber?: string, signal?: AbortSignal): Promise<Company> {
  const body = businessNumber === undefined ? input : { businessNumber, ...input }
  return toCompany(companyDtoSchema.parse(await apiRequest(companyPath, {
    method: businessNumber === undefined ? 'PUT' : 'POST', accessToken: token, body, signal,
  })))
}

/** Only a confirmed absent company is null; an unset profile is the server's validated empty model. */
export async function getCompanyPartnerProfile(token: string, signal?: AbortSignal): Promise<CompanyPartnerProfile | null> {
  try {
    return toCompanyPartnerProfile(companyPartnerProfileDtoSchema.parse(
      await apiRequest(`${companyPath}/partner-profile`, { accessToken: token, signal }),
    ))
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404 && cause.code === 'COMPANY_NOT_REGISTERED') return null
    throw cause
  }
}

/** Shared validation and normalization run before PUT; external DTO conversion stays in this API boundary. */
export function saveCompanyPartnerProfile(token: string, input: CompanyPartnerProfileInput, signal?: AbortSignal) {
  return new UpdateCompanyPartnerProfileUseCase({
    async updatePartnerProfile(value, requestSignal) {
      return toCompanyPartnerProfile(companyPartnerProfileDtoSchema.parse(
        await apiRequest(`${companyPath}/partner-profile`, { method: 'PUT', body: value, accessToken: token, signal: requestSignal }),
      ))
    },
  }).execute(input, signal)
}
