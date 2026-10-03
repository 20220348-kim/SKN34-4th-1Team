import { businessLookupDtoSchema, companyDtoSchema, toBusinessLookup, toCompany } from '@govbiz/shared/data/models/CompanyDto'
import type { BusinessLookup, Company, CompanyProfileInput } from '@govbiz/shared/domain/entities/Company'
import { apiRequest } from './client'

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
